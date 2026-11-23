//! Two nodes, one process: proves the swarm actually moves a message.
//! Run with `cargo run --bin twonode`.

use std::time::Duration;

use bling::net::{self, Cmd, Out};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let failures = std::cell::Cell::new(0usize);
    let check = |label: &str, ok: bool| {
        println!("{} {}", if ok { "ok  " } else { "FAIL" }, label);
        if !ok {
            failures.set(failures.get() + 1);
        }
    };

    // Identity survives a reload.
    let dir = std::env::temp_dir().join("bling-idtest");
    let _ = std::fs::remove_dir_all(&dir);
    let key_a = net::load_or_create_key(&dir.join("k1"))?;
    let key_b = net::load_or_create_key(&dir.join("k1"))?;
    check(
        "identity is stable across reloads",
        key_a.public() == key_b.public(),
    );

    let key_a = net::new_identity();
    let key_b = net::new_identity();

    // A scratch dir for the peer book, so the restart check starts clean.
    let book_dir = std::env::temp_dir().join("bling-booktest");
    let _ = std::fs::remove_dir_all(&book_dir);
    let book_path = book_dir.join("peers.json");

    let (net_a, swarm_a, cmd_a) = net::create(key_a.clone(), &["/ip4/127.0.0.1/tcp/0"])?;
    let (net_b, swarm_b, cmd_b) = net::create(key_b, &["/ip4/127.0.0.1/tcp/0"])?;

    let (tx_a, mut rx_a) = mpsc::unbounded_channel::<Out>();
    let (tx_b, mut rx_b) = mpsc::unbounded_channel::<Out>();
    tokio::spawn(net::drive(swarm_a, cmd_a, tx_a, vec!["lobby".into()], net::PeerBook::at(book_path.clone())));
    tokio::spawn(net::drive(swarm_b, cmd_b, tx_b, vec!["lobby".into()], net::PeerBook::memory()));

    // Wait for node B to report a dialable TCP address.
    let addr = loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx_b.recv())
            .await
            .expect("node B never reported an address")
            .expect("channel closed");
        if let Out::Listening { addrs } = ev {
            if let Some(a) = addrs
                .into_iter()
                .find(|a| a.contains("/tcp/") && a.contains("127.0.0.1"))
            {
                break a;
            }
        }
    };
    check("node B is listening", !addr.is_empty());
    println!("     B address: {addr}");

    net_a.send(Cmd::Dial(addr.clone()));

    // Wait for the connection, then give gossipsub a heartbeat to graft the mesh.
    let mut connected = false;
    for _ in 0..40 {
        if let Ok(Some(ev)) = tokio::time::timeout(Duration::from_millis(250), rx_a.recv()).await {
            if let Out::Peer { online: true, .. } = ev {
                connected = true;
                break;
            }
        }
    }
    check("node A connected to node B", connected);

    // Presence: B learns A's name without A sending a chat message.
    net_a.send(Cmd::Announce("alice".into()));
    let mut named = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Out::Nick { nick, .. })) =
            tokio::time::timeout(Duration::from_millis(300), rx_b.recv()).await
        {
            if nick == "alice" {
                named = true;
                break;
            }
        }
    }
    check("a nickname arrives without any chat message", named);

    tokio::time::sleep(Duration::from_millis(2200)).await;

    net_a.send(Cmd::Publish {
        room: "lobby".into(),
        nick: "alice".into(),
        text: "hello from rust".into(),
    });

    let mut received = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(300), rx_b.recv()).await {
            Ok(Some(Out::Message { text, nick, room, from, .. })) => {
                received = Some((nick, room, text, from));
                break;
            }
            _ => continue,
        }
    }

    match received {
        Some((nick, room, text, from)) => {
            check("node B received the message", text == "hello from rust");
            check("message kept its room", room == "lobby");
            check("message kept the sender's nickname", nick == "alice");
            check("message came from node A", from == net_a.peer_id.to_string());
        }
        None => check("node B received the message", false),
    }

    net_a.send(Cmd::Publish {
        room: "lobby".into(),
        nick: "alice".into(),
        text: "second".into(),
    });
    let mut second = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Out::Message { text, .. })) =
            tokio::time::timeout(Duration::from_millis(300), rx_b.recv()).await
        {
            if text == "second" {
                second = true;
                break;
            }
        }
    }
    check("a second message also arrives", second);

    // --- persistent pairing ---
    // Pair with the full address, then let the book flush (it saves on the 3s tick).
    net_a.send(Cmd::Dial(format!("{addr}/p2p/{}", net_b.peer_id)));
    tokio::time::sleep(Duration::from_secs(4)).await;
    let saved = std::fs::read_to_string(&book_path).unwrap_or_default();
    check("the paired peer is written to peers.json", saved.contains(&net_b.peer_id.to_string()));

    // Restart: same identity, same book, no manual dial.
    drop(net_a);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (net_c, swarm_c, cmd_c) = net::create(key_a, &["/ip4/127.0.0.1/tcp/0"])?;
    let (tx_c, mut rx_c) = mpsc::unbounded_channel::<Out>();
    tokio::spawn(net::drive(
        swarm_c,
        cmd_c,
        tx_c,
        vec!["lobby".into()],
        net::PeerBook::at(book_path.clone()),
    ));

    let mut redialled = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Out::Peer { peer_id, online: true, .. })) =
            tokio::time::timeout(Duration::from_millis(300), rx_c.recv()).await
        {
            if peer_id == net_b.peer_id.to_string() {
                redialled = true;
                break;
            }
        }
    }
    check("a restarted node redials saved peers by itself", redialled);

    // Give gossipsub a moment to graft the mesh before publishing into it.
    tokio::time::sleep(Duration::from_secs(3)).await;
    net_b.send(Cmd::Publish {
        room: "lobby".into(),
        nick: "robin".into(),
        text: "after restart".into(),
    });
    let mut after = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Out::Message { text, .. })) =
            tokio::time::timeout(Duration::from_millis(300), rx_c.recv()).await
        {
            if text == "after restart" {
                after = true;
                break;
            }
        }
    }
    check("messages flow to the restarted node", after);
    let _ = net_c;

    println!();
    if failures.get() == 0 {
        println!("PASS: all checks passed");
        Ok(())
    } else {
        Err(format!("{} check(s) failed", failures.get()).into())
    }
}
