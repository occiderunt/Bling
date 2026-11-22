//! Bling networking: a small libp2p swarm doing gossipsub chat over
//! TCP + QUIC, with mDNS for local discovery. No Tauri dependencies here so
//! the same code can be driven by a plain test binary.

use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
    path::Path,
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

/// Remember every address we hear for a peer. A single stale one (VPN, a
/// changed interface) would otherwise poison every reconnect attempt.
fn remember(known: &mut HashMap<PeerId, Vec<Multiaddr>>, peer: PeerId, addr: Multiaddr) {
    let list = known.entry(peer).or_default();
    if list.len() < 8 && !list.contains(&addr) {
        list.push(addr);
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
    let mut known: HashMap<PeerId, Vec<Multiaddr>> = HashMap::new();
    // peer -> (when to try again, how many failures so far)
    let mut retry: HashMap<PeerId, (Instant, u32)> = HashMap::new();

    let mut redial_tick = tokio::time::interval(Duration::from_secs(3));
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
                            if let Some(peer) = peer_of(&addr) {
                                remember(&mut known, peer, addr.clone());
                                retry.remove(&peer);
                            }
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
            _ = redial_tick.tick() => {
                let now = Instant::now();
                let due: Vec<(PeerId, Vec<Multiaddr>)> = known
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
                SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                    connected.insert(peer_id);
                    retry.remove(&peer_id);
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
                    if known.contains_key(&peer_id) {
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
                    // The retry slot was already booked before dialing; only
                    // report the failure here.
                    if peer_id.is_none() {
                        let _ = out.send(Out::Notice { text: format!("could not connect: {error}") });
                    }
                }
                SwarmEvent::Behaviour(BehavioursEvent::Mdns(mdns::Event::Discovered(list))) => {
                    for (peer_id, addr) in list {
                        remember(&mut known, peer_id, addr.clone());
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
                        remember(&mut known, peer_id, addr.clone());
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
}
