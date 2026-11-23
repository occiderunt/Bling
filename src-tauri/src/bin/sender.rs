//! A controllable peer for testing notifications: dials a given address,
//! waits for the connection, then publishes a few messages.
//!
//!   cargo run --bin sender -- /ip4/127.0.0.1/tcp/4198 --room lobby --nick robin --count 3 --delay 2 --text "hello"

use std::time::Duration;

use bling::net::{self, Cmd, Out};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };
    let target = args.get(1).cloned().unwrap_or_else(|| {
        eprintln!("usage: sender <multiaddr> [--room r] [--nick n] [--count n] [--delay s] [--text s]");
        std::process::exit(2);
    });
    let room = flag("--room", "lobby");
    let nick = flag("--nick", "robin");
    let count: usize = flag("--count", "3").parse().unwrap_or(3);
    let delay: u64 = flag("--delay", "2").parse().unwrap_or(2);
    let text = flag("--text", "ping from the other machine");

    let key = net::new_identity();
    let (net, swarm, cmds) = net::create(key, &["/ip4/0.0.0.0/tcp/0"])?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(net::drive(swarm, cmds, tx, vec![room.clone()]));
    println!("sender peer {}", net.peer_id);

    net.send(Cmd::Dial(target.clone()));
    println!("dialing {target}");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut connected = false;
    while !connected && tokio::time::Instant::now() < deadline {
        if let Ok(Some(ev)) = tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
            if let Out::Peer { online: true, .. } = ev {
                connected = true;
            }
        }
    }
    println!("connected: {connected}");
    if !connected {
        std::process::exit(1);
    }

    tokio::time::sleep(Duration::from_secs(2)).await;
    for i in 1..=count {
        net.send(Cmd::Publish {
            room: room.clone(),
            nick: nick.clone(),
            text: format!("{text} #{i}"),
        });
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    Ok(())
}
