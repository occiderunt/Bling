//! Bling networking: a small libp2p swarm doing gossipsub chat over
//! TCP + QUIC, with mDNS for local discovery. No Tauri dependencies here so
//! the same code can be driven by a plain test binary.

use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    hash::{Hash, Hasher},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures::StreamExt;
use libp2p::{
    gossipsub, identify, identity, mdns, noise, ping,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, Swarm, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub const PROTOCOL: &str = "/bling/0.1.0";

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
    Notice { text: String },
}

/// What the UI can ask the swarm to do.
#[derive(Debug, Clone)]
pub enum Cmd {
    Join(String),
    Dial(String),
    Publish { room: String, nick: String, text: String },
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

    let mut addrs: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            maybe = cmds.recv() => match maybe {
                None => break,
                Some(Cmd::Join(room)) => {
                    if joined.insert(room.clone()) {
                        let _ = swarm.behaviour_mut().gossipsub.subscribe(&topic_for(&room));
                        let _ = out.send(Out::Notice { text: format!("joined #{room}") });
                    }
                }
                Some(Cmd::Dial(raw)) => {
                    match raw.parse::<Multiaddr>() {
                        Ok(addr) => match swarm.dial(addr.clone()) {
                            Ok(()) => { let _ = out.send(Out::Notice { text: format!("dialing {addr}") }); }
                            Err(e) => { let _ = out.send(Out::Notice { text: format!("dial failed: {e}") }); }
                        },
                        Err(e) => { let _ = out.send(Out::Notice { text: format!("bad address: {e}") }); }
                    }
                }
                Some(Cmd::Publish { room, nick, text }) => {
                    let ts = now_ms();
                    let wire = Wire {
                        v: 1,
                        id: format!("{ts}-{text:?}"),
                        nick,
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
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let s = address.to_string();
                    if !addrs.contains(&s) {
                        addrs.push(s);
                        let _ = out.send(Out::Listening { addrs: addrs.clone() });
                    }
                }
                SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                    let _ = out.send(Out::Peer {
                        peer_id: peer_id.to_string(),
                        addr: None,
                        online: true,
                        rtt_ms: None,
                    });
                }
                SwarmEvent::ConnectionClosed { peer_id, .. } => {
                    let _ = out.send(Out::Peer {
                        peer_id: peer_id.to_string(),
                        addr: None,
                        online: false,
                        rtt_ms: None,
                    });
                }
                SwarmEvent::OutgoingConnectionError { error, .. } => {
                    let _ = out.send(Out::Notice { text: format!("could not connect: {error}") });
                }
                SwarmEvent::Behaviour(BehavioursEvent::Mdns(mdns::Event::Discovered(list))) => {
                    for (peer_id, addr) in list {
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
                    if let Ok(wire) = serde_json::from_slice::<Wire>(&message.data) {
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
