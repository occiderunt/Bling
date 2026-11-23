//! Bling networking: a small libp2p swarm doing gossipsub chat over
//! TCP + QUIC, with mDNS for local discovery. No Tauri dependencies here so
//! the same code can be driven by a plain test binary.

use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures::StreamExt;
use libp2p::{
    gossipsub, identify, identity, mdns, multiaddr::Protocol, noise, ping,
    swarm::{dial_opts::DialOpts, NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, Swarm, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub const PROTOCOL: &str = "/bling/0.1.0";

/// Everyone subscribes here and re-announces their nickname, so peers get a
/// name before they ever type anything.
const PRESENCE_TOPIC: &str = "bling/presence";

fn topic_for(room: &str) -> gossipsub::IdentTopic {
    gossipsub::IdentTopic::new(format!("bling/room/{room}"))
}

fn room_from_topic(topic: &gossipsub::TopicHash) -> String {
    topic
        .as_str()
        .strip_prefix("bling/room/")
        .unwrap_or(topic.as_str())
        .to_string()
}

#[derive(NetworkBehaviour)]
pub struct Behaviours {
    pub gossipsub: gossipsub::Behaviour,
    pub mdns: mdns::tokio::Behaviour,
    pub identify: identify::Behaviour,
    pub ping: ping::Behaviour,
}

/// What the swarm tells the outside world.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Out {
    Ready { peer_id: String },
    Listening { addrs: Vec<String> },
    Peer { peer_id: String, addr: Option<String>, online: bool, rtt_ms: Option<u64> },
    Message { id: String, room: String, from: String, nick: String, text: String, ts: u64 },
    Nick { peer_id: String, nick: String },
    Notice { text: String },
}

/// What the UI can ask the swarm to do.
#[derive(Debug, Clone)]
pub enum Cmd {
    Join(String),
    Leave(String),
    Dial(String),
    Announce(String),
    Publish { room: String, nick: String, text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Presence {
    v: u8,
    nick: String,
    ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Wire {
    v: u8,
    id: String,
    nick: String,
    text: String,
    ts: u64,
}

pub struct Net {
    pub peer_id: PeerId,
    cmd: mpsc::UnboundedSender<Cmd>,
}

impl Net {
    pub fn send(&self, cmd: Cmd) {
        let _ = self.cmd.send(cmd);
    }
}

pub fn new_identity() -> identity::Keypair {
    identity::Keypair::generate_ed25519()
}

/// Load the node identity from disk, or make one and save it. Stable peer id
/// across restarts matters: friends recognise you by it.
pub fn load_or_create_key(path: &Path) -> Result<identity::Keypair, String> {
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(key) = identity::Keypair::from_protobuf_encoding(&bytes) {
            return Ok(key);
        }
    }
    let key = new_identity();
    let bytes = key.to_protobuf_encoding().map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())?;
    Ok(key)
}

pub fn create(
    key: identity::Keypair,
    listen_addrs: &[&str],
) -> Result<(Net, Swarm<Behaviours>, mpsc::UnboundedReceiver<Cmd>), String> {
    let peer_id = key.public().to_peer_id();

    let mut swarm = SwarmBuilder::with_existing_identity(key.clone())
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|e| e.to_string())?
        .with_quic()
        .with_behaviour(|key| {
            let message_id_fn = |message: &gossipsub::Message| {
                let mut s = DefaultHasher::new();
                message.source.hash(&mut s);
                message.data.hash(&mut s);
                gossipsub::MessageId::from(s.finish().to_string())
            };

            let cfg = gossipsub::ConfigBuilder::default()
                .heartbeat_interval(Duration::from_millis(700))
                .validation_mode(gossipsub::ValidationMode::Strict)
                .message_id_fn(message_id_fn)
                .build()
                .map_err(std::io::Error::other)?;

            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                cfg,
            )?;
            let mdns =
                mdns::tokio::Behaviour::new(mdns::Config::default(), peer_id)?;
            let identify = identify::Behaviour::new(identify::Config::new(
                PROTOCOL.to_string(),
                key.public(),
            ));
            let ping = ping::Behaviour::new(ping::Config::new());

            Ok(Behaviours { gossipsub, mdns, identify, ping })
        })
        .map_err(|e| e.to_string())?
        .build();

    for addr in listen_addrs {
        let addr: Multiaddr = addr.parse().map_err(|e: libp2p::multiaddr::Error| e.to_string())?;
        swarm.listen_on(addr).map_err(|e| e.to_string())?;
    }

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    Ok((Net { peer_id, cmd: cmd_tx }, swarm, cmd_rx))
}

/// Ports that stay put across launches, so your multiaddr does too. 4101 is
/// arbitrary; if something else holds it we hand back 0 and let the OS pick.
pub fn stable_listen_ports(base: u16) -> (u16, u16, bool) {
    fn free_tcp(from: u16) -> Option<u16> {
        (from..from.saturating_add(10))
            .find(|p| std::net::TcpListener::bind(("0.0.0.0", *p)).is_ok())
    }
    fn free_udp(from: u16) -> Option<u16> {
        (from..from.saturating_add(10))
            .find(|p| std::net::UdpSocket::bind(("0.0.0.0", *p)).is_ok())
    }
    let tcp = free_tcp(base);
    let quic = free_udp(base);
    (tcp.unwrap_or(0), quic.unwrap_or(0), tcp.is_some() && quic.is_some())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn short(peer: &PeerId) -> String {
    let s = peer.to_string();
    s.chars().take(10).collect()
}

fn peer_of(addr: &Multiaddr) -> Option<PeerId> {
    addr.iter().find_map(|p| match p {
        Protocol::P2p(id) => Some(id),
        _ => None,
    })
}

/// Peers you have paired with, kept on disk so a restart knows who to dial.
/// Addresses are learned from identify and mDNS; a peer that has not been
/// seen for a month is forgotten so the book does not grow forever.
#[derive(Serialize, Deserialize)]
struct SavedPeer {
    addrs: Vec<String>,
    #[serde(default)]
    seen: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedBook {
    v: u8,
    peers: HashMap<String, SavedPeer>,
}

const PEER_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const PEER_MAX_ADDRS: usize = 8;

pub struct PeerBook {
    path: Option<PathBuf>,
    known: HashMap<PeerId, Vec<Multiaddr>>,
    seen: HashMap<PeerId, u64>,
    dirty: bool,
}

impl PeerBook {
    /// A book that forgets everything when the process exits. Test binaries
    /// use this; the app uses `at`.
    pub fn memory() -> Self {
        Self { path: None, known: HashMap::new(), seen: HashMap::new(), dirty: false }
    }

    pub fn at(path: PathBuf) -> Self {
        let mut book = Self {
            path: Some(path.clone()),
            known: HashMap::new(),
            seen: HashMap::new(),
            dirty: false,
        };
        let raw = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return book,
        };
        let saved: SavedBook = match serde_json::from_slice(&raw) {
            Ok(s) => s,
            Err(_) => return book,
        };
        let now = now_ms();
        for (id, peer) in saved.peers {
            if peer.seen != 0 && now.saturating_sub(peer.seen) > PEER_TTL_MS {
                continue;
            }
            let peer_id: PeerId = match id.parse() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let addrs: Vec<Multiaddr> = peer
                .addrs
                .iter()
                .filter_map(|a| a.parse().ok())
                .take(PEER_MAX_ADDRS)
                .collect();
            if addrs.is_empty() {
                continue;
            }
            book.known.insert(peer_id, addrs);
            book.seen.insert(peer_id, peer.seen);
        }
        book
    }

    pub fn known(&self) -> &HashMap<PeerId, Vec<Multiaddr>> {
        &self.known
    }

    /// Remember every address we hear for a peer. A single stale one (VPN, a
    /// changed interface) would otherwise poison every reconnect attempt.
    pub fn remember(&mut self, peer: PeerId, addr: Multiaddr) {
        let list = self.known.entry(peer).or_default();
        if list.len() < PEER_MAX_ADDRS && !list.contains(&addr) {
            list.push(addr);
            self.dirty = true;
        }
        self.touch(peer);
    }

    pub fn touch(&mut self, peer: PeerId) {
        self.seen.insert(peer, now_ms());
        self.dirty = true;
    }

    /// Write the book if anything changed. Called on a timer, not per event.
    pub fn flush(&mut self) {
        if !self.dirty {
            return;
        }
        let Some(path) = self.path.clone() else {
            self.dirty = false;
            return;
        };
        let mut peers: HashMap<String, SavedPeer> = HashMap::new();
        for (peer, addrs) in &self.known {
            peers.insert(
                peer.to_string(),
                SavedPeer {
                    addrs: addrs.iter().map(|a| a.to_string()).collect(),
                    seen: self.seen.get(peer).copied().unwrap_or(0),
                },
            );
        }
        let saved = SavedBook { v: 1, peers };
        let Ok(json) = serde_json::to_vec_pretty(&saved) else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Write beside the real file so a crash mid-write cannot truncate it.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path)).is_ok() {
            self.dirty = false;
        }
    }
}

fn announce(swarm: &mut Swarm<Behaviours>, nick: &str) {
    if nick.trim().is_empty() {
        return;
    }
    let payload = match serde_json::to_vec(&Presence {
        v: 1,
        nick: nick.to_string(),
        ts: now_ms(),
    }) {
        Ok(p) => p,
        Err(_) => return,
    };
    let _ = swarm
        .behaviour_mut()
        .gossipsub
        .publish(gossipsub::IdentTopic::new(PRESENCE_TOPIC), payload);
}

/// Run the swarm until the command channel closes.
pub async fn drive(
    mut swarm: Swarm<Behaviours>,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
    out: mpsc::UnboundedSender<Out>,
    rooms: Vec<String>,
    mut book: PeerBook,
) {
    let _ = out.send(Out::Ready { peer_id: swarm.local_peer_id().to_string() });

    let mut joined: HashSet<String> = HashSet::new();
    for room in &rooms {
        if swarm.behaviour_mut().gossipsub.subscribe(&topic_for(room)).is_ok() {
            joined.insert(room.clone());
        }
    }
    let _ = swarm
        .behaviour_mut()
        .gossipsub
        .subscribe(&gossipsub::IdentTopic::new(PRESENCE_TOPIC));

    let mut nick = String::new();
    let mut addrs: Vec<String> = Vec::new();
    let mut connected: HashSet<PeerId> = HashSet::new();
    // Paired peers from the last run are dialled as soon as we come up.
    let mut retry: HashMap<PeerId, (Instant, u32)> = book
        .known()
        .keys()
        .map(|peer| (*peer, (Instant::now(), 0)))
        .collect();
    // Dials the user asked for by hand, waiting for success or failure.
    let mut pending: Vec<(Option<PeerId>, Multiaddr, Instant)> = Vec::new();

    let mut redial_tick = tokio::time::interval(Duration::from_secs(3));
    let mut dial_tick = tokio::time::interval(Duration::from_secs(1));
    let mut presence_tick = tokio::time::interval(Duration::from_secs(6));
    presence_tick.tick().await;

    loop {
        tokio::select! {
            maybe = cmds.recv() => match maybe {
                None => break,
                Some(Cmd::Join(room)) => {
                    if joined.insert(room.clone()) {
                        let _ = swarm.behaviour_mut().gossipsub.subscribe(&topic_for(&room));
                    }
                }
                Some(Cmd::Leave(room)) => {
                    if joined.remove(&room) {
                        let _ = swarm.behaviour_mut().gossipsub.unsubscribe(&topic_for(&room));
                    }
                }
                Some(Cmd::Announce(name)) => {
                    nick = name;
                    announce(&mut swarm, &nick);
                }
                Some(Cmd::Dial(raw)) => {
                    match raw.parse::<Multiaddr>() {
                        Ok(addr) => {
                            let peer = peer_of(&addr);
                            if let Some(peer) = peer {
                                book.remember(peer, addr.clone());
                                retry.remove(&peer);
                            }
                            pending.push((peer, addr.clone(), Instant::now()));
                            match swarm.dial(addr.clone()) {
                                Ok(()) => { let _ = out.send(Out::Notice { text: format!("dialing {addr}") }); }
                                Err(e) => { let _ = out.send(Out::Notice { text: format!("dial failed: {e}") }); }
                            }
                        }
                        Err(e) => { let _ = out.send(Out::Notice { text: format!("bad address: {e}") }); }
                    }
                }
                Some(Cmd::Publish { room, nick: who, text }) => {
                    let ts = now_ms();
                    let wire = Wire {
                        v: 1,
                        id: format!("{ts}-{text:?}"),
                        nick: who,
                        text,
                        ts,
                    };
                    match serde_json::to_vec(&wire) {
                        Ok(payload) => {
                            let topic = topic_for(&room);
                            if joined.insert(room.clone()) {
                                let _ = swarm.behaviour_mut().gossipsub.subscribe(&topic);
                            }
                            match swarm.behaviour_mut().gossipsub.publish(topic, payload) {
                                Ok(_) => {}
                                Err(gossipsub::PublishError::NoPeersSubscribedToTopic) => {
                                    let _ = out.send(Out::Notice { text: "nobody else is on this room yet".into() });
                                }
                                Err(e) => {
                                    let _ = out.send(Out::Notice { text: format!("send failed: {e}") });
                                }
                            }
                        }
                        Err(e) => { let _ = out.send(Out::Notice { text: format!("encode failed: {e}") }); }
                    }
                }
            },
            _ = dial_tick.tick() => {
                let now = Instant::now();
                let mut still = Vec::new();
                for (peer, addr, at) in pending.drain(..) {
                    if now.duration_since(at) >= Duration::from_secs(15) {
                        let _ = out.send(Out::Notice {
                            text: format!("no answer from {addr} after 15s, giving up"),
                        });
                        if let Some(peer) = peer {
                            retry.remove(&peer);
                        }
                    } else {
                        still.push((peer, addr, at));
                    }
                }
                pending = still;
            }
            _ = redial_tick.tick() => {
                let now = Instant::now();
                book.flush();
                let due: Vec<(PeerId, Vec<Multiaddr>)> = book
                    .known()
                    .iter()
                    .filter(|(peer, _)| !connected.contains(*peer))
                    .filter(|(peer, _)| retry.get(*peer).map(|(at, _)| *at <= now).unwrap_or(false))
                    .map(|(peer, addrs)| (*peer, addrs.clone()))
                    .collect();
                for (peer, addrs) in due {
                    if addrs.is_empty() {
                        continue;
                    }
                    // Book the next attempt before dialing: libp2p can report a
                    // refused connection with no peer id, which used to leave a
                    // "dialing" flag stuck and stop all further attempts.
                    let attempts = retry.get(&peer).map(|(_, a)| *a).unwrap_or(0);
                    let backoff = (3u64 << attempts.min(3)).min(20);
                    retry.insert(
                        peer,
                        (Instant::now() + Duration::from_secs(backoff), attempts + 1),
                    );
                    let opts = DialOpts::peer_id(peer).addresses(addrs).build();
                    let _ = swarm.dial(opts);
                }
            }
            _ = presence_tick.tick() => announce(&mut swarm, &nick),
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let s = address.to_string();
                    if !addrs.contains(&s) {
                        addrs.push(s);
                        let _ = out.send(Out::Listening { addrs: addrs.clone() });
                    }
                }
                SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                    pending.retain(|(p, _, _)| *p != Some(peer_id));
                    // A manual dial by address has no peer id, so clear it by address
                    // or it would later report a bogus "no answer" timeout.
                    let remote = endpoint.get_remote_address().clone();
                    pending.retain(|(_, addr, _)| addr != &remote);
                    connected.insert(peer_id);
                    retry.remove(&peer_id);
                    book.touch(peer_id);
                    let _ = out.send(Out::Peer {
                        peer_id: peer_id.to_string(),
                        addr: None,
                        online: true,
                        rtt_ms: None,
                    });
                    announce(&mut swarm, &nick);
                }
                SwarmEvent::ConnectionClosed { peer_id, .. } => {
                    connected.remove(&peer_id);
                    if book.known().contains_key(&peer_id) {
                        retry.insert(peer_id, (Instant::now() + Duration::from_secs(3), 0));
                    }
                    let _ = out.send(Out::Peer {
                        peer_id: peer_id.to_string(),
                        addr: None,
                        online: false,
                        rtt_ms: None,
                    });
                }
                SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                    // Only surface failures for dials the user actually made;
                    // background redials stay quiet so the timeline isn't spam.
                    if let Some(pos) = pending.iter().position(|(p, _, _)| *p == peer_id) {
                        let (_, addr, _) = pending.remove(pos);
                        let _ = out.send(Out::Notice { text: format!("could not connect to {addr}: {error}") });
                    }
                }
                SwarmEvent::Behaviour(BehavioursEvent::Mdns(mdns::Event::Discovered(list))) => {
                    for (peer_id, addr) in list {
                        book.remember(peer_id, addr.clone());
                        swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                        let _ = out.send(Out::Peer {
                            peer_id: peer_id.to_string(),
                            addr: Some(addr.to_string()),
                            online: true,
                            rtt_ms: None,
                        });
                    }
                }
                SwarmEvent::Behaviour(BehavioursEvent::Mdns(mdns::Event::Expired(list))) => {
                    for (peer_id, _addr) in list {
                        swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer_id);
                        let _ = out.send(Out::Peer {
                            peer_id: peer_id.to_string(),
                            addr: None,
                            online: false,
                            rtt_ms: None,
                        });
                    }
                }
                SwarmEvent::Behaviour(BehavioursEvent::Gossipsub(gossipsub::Event::Message {
                    propagation_source,
                    message,
                    ..
                })) => {
                    if message.topic.as_str() == PRESENCE_TOPIC {
                        if let Ok(p) = serde_json::from_slice::<Presence>(&message.data) {
                            let name = p.nick.trim();
                            if !name.is_empty() {
                                let from = message.source.unwrap_or(propagation_source);
                                let _ = out.send(Out::Nick {
                                    peer_id: from.to_string(),
                                    nick: name.to_string(),
                                });
                            }
                        }
                    } else if let Ok(wire) = serde_json::from_slice::<Wire>(&message.data) {
                        let room = room_from_topic(&message.topic);
                        let _ = out.send(Out::Message {
                            id: wire.id,
                            room,
                            from: message
                                .source
                                .unwrap_or(propagation_source)
                                .to_string(),
                            nick: if wire.nick.trim().is_empty() { short(&propagation_source) } else { wire.nick },
                            text: wire.text,
                            ts: wire.ts,
                        });
                    }
                }
                SwarmEvent::Behaviour(BehavioursEvent::Ping(ping::Event { peer, result, .. })) => {
                    if let Ok(rtt) = result {
                        let _ = out.send(Out::Peer {
                            peer_id: peer.to_string(),
                            addr: None,
                            online: true,
                            rtt_ms: Some(rtt.as_millis() as u64),
                        });
                    }
                }
                SwarmEvent::Behaviour(BehavioursEvent::Identify(identify::Event::Received {
                    peer_id,
                    info,
                    ..
                })) => {
                    for addr in &info.listen_addrs {
                        book.remember(peer_id, addr.clone());
                    }
                    let addr = info.listen_addrs.first().map(|a| a.to_string());
                    let _ = out.send(Out::Peer {
                        peer_id: peer_id.to_string(),
                        addr,
                        online: true,
                        rtt_ms: None,
                    });
                }
                _ => {}
            }
        }
    }
    book.flush();
}
