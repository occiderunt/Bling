//! A throwaway peer used to prove the running app receives real traffic.
//!
//!   cargo run --bin bot -- --listen   # prints an address, waits, then chats
//!   cargo run --bin bot               # discovers over mdns, then chats

use std::time::Duration;

use bling::net::{self, Cmd, Out};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listen_only = std::env::args().any(|a| a == "--listen");

    let key = net::new_identity();
    let (net, swarm, cmds) = net::create(key, &["/ip4/0.0.0.0/tcp/0"])?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(net::drive(swarm, cmds, tx, vec!["lobby".into()]));
    println!("bot peer {}", net.peer_id);

    let lines = [
        "hey, it's robin on the other machine",
        "connected straight across, no server in the middle",
        "that mint pill is doing a lot of work",
    ];

    let started = tokio::time::Instant::now();
    let mut connected = false;
    let mut printed = false;

    // Announce a dialable address so an app can connect to us by hand.
    while !printed && started.elapsed() < Duration::from_secs(10) {
        if let Ok(Some(ev)) = tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
            match ev {
                Out::Listening { addrs } => {
                    if let Some(addr) = addrs
                        .iter()
                        .find(|a| a.contains("127.0.0.1") && a.contains("/tcp/"))
                    {
                        let dial = format!("{addr}/p2p/{}", net.peer_id);
                        println!("ADDR {dial}");
                        let _ = std::fs::write("/tmp/bling-bot.addr", dial);
                        printed = true;
                    }
                }
                Out::Peer { online: true, .. } => connected = true,
                _ => {}
            }
        }
    }

    let patience = if listen_only { 60 } else { 15 };
    while !connected && started.elapsed() < Duration::from_secs(patience + 10) {
        if let Ok(Some(Out::Peer { online: true, .. })) =
            tokio::time::timeout(Duration::from_millis(300), rx.recv()).await
        {
            connected = true;
        }
    }
    println!("peer connected: {connected}");

    if connected {
        tokio::time::sleep(Duration::from_millis(2200)).await;
        for line in lines {
            net.send(Cmd::Publish {
                room: "lobby".into(),
                nick: "robin".into(),
                text: line.into(),
            });
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
    Ok(())
}
