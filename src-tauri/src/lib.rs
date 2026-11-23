pub mod net;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use crate::net::{Cmd, Net, Out};
use serde::Serialize;
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::broadcast;

/// Whether the UI is actually on screen. The webview reports this from
/// document.visibilityState, which is reliable on Android where window focus
/// stays true even after the app is backgrounded.
static APP_ACTIVE: AtomicBool = AtomicBool::new(true);

#[derive(Clone, Serialize)]
struct PeerSnap {
    peer_id: String,
    addr: Option<String>,
    online: bool,
    rtt_ms: Option<u64>,
}

#[derive(Default)]
struct Snapshot {
    addrs: Vec<String>,
    peers: Vec<PeerSnap>,
}

struct AppState {
    net: Mutex<Option<Net>>,
    peer_id: Mutex<Option<String>>,
    rooms: Mutex<Vec<String>>,
    /// Every swarm event goes through here, so a webview reload can re-attach
    /// a channel without starting a second swarm (or a second port).
    bus: broadcast::Sender<Out>,
    snap: Arc<Mutex<Snapshot>>,
}

impl AppState {
    fn with(&self, f: impl FnOnce(&Net) -> Result<(), String>) -> Result<(), String> {
        let slot = self.net.lock().map_err(|e| e.to_string())?;
        match slot.as_ref() {
            Some(net) => f(net),
            None => Err("swarm is not running".into()),
        }
    }

    /// Replay everything we already know, then pump live events into `channel`.
    fn attach(&self, channel: Channel<Out>, peer_id: &str) {
        let mut rx = self.bus.subscribe();

        let _ = channel.send(Out::Ready { peer_id: peer_id.to_string() });
        if let Ok(snap) = self.snap.lock() {
            if !snap.addrs.is_empty() {
                let _ = channel.send(Out::Listening { addrs: snap.addrs.clone() });
            }
            for p in &snap.peers {
                let _ = channel.send(Out::Peer {
                    peer_id: p.peer_id.clone(),
                    addr: p.addr.clone(),
                    online: p.online,
                    rtt_ms: p.rtt_ms,
                });
            }
        }

        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        if channel.send(event).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

#[derive(Serialize)]
struct Me {
    peer_id: String,
}

#[tauri::command]
async fn bling_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    channel: Channel<Out>,
    nick: Option<String>,
) -> Result<Me, String> {
    if let Some(peer_id) = state.peer_id.lock().map_err(|e| e.to_string())?.clone() {
        state.attach(channel, &peer_id);
        if let Some(nick) = nick {
            state.with(|net| {
                net.send(Cmd::Announce(nick));
                Ok(())
            })?;
        }
        return Ok(Me { peer_id });
    }

    let dir = match std::env::var("BLING_DATA") {
        Ok(path) => PathBuf::from(path),
        Err(_) => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = net::load_or_create_key(&dir.join("identity.key"))?;

    let (tcp, quic, stable) = net::stable_listen_ports(4101);
    let listen = [
        format!("/ip4/0.0.0.0/tcp/{tcp}"),
        format!("/ip4/0.0.0.0/udp/{quic}/quic-v1"),
    ];
    let refs: Vec<&str> = listen.iter().map(String::as_str).collect();

    let (handle, swarm, cmd_rx) = net::create(key, &refs)?;
    let peer_id = handle.peer_id.to_string();

    // Attach before the swarm starts talking, so nothing is missed.
    state.attach(channel, &peer_id);

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Out>();
    let bus = state.bus.clone();
    let snap = Arc::clone(&state.snap);
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = out_rx.recv().await {
            if let Out::Message { room, nick, text, .. } = &event {
                let active = APP_ACTIVE.load(Ordering::Relaxed);
                #[cfg(desktop)]
                let focused = app_handle
                    .webview_windows()
                    .values()
                    .any(|w| w.is_focused().unwrap_or(false));
                #[cfg(not(desktop))]
                let focused = active;
                if !(active && focused) {
                    let title = format!("#{room} · {nick}");
                    let body = if text.chars().count() > 140 {
                        let cut: String = text.chars().take(139).collect();
                        format!("{cut}…")
                    } else {
                        text.clone()
                    };
                    notify(&app_handle, &title, &body);
                }
            }
            if let Ok(mut s) = snap.lock() {
                match &event {
                    Out::Listening { addrs } => s.addrs = addrs.clone(),
                    Out::Peer { peer_id, addr, online, rtt_ms } => {
                        if let Some(p) = s.peers.iter_mut().find(|p| &p.peer_id == peer_id) {
                            if addr.is_some() {
                                p.addr = addr.clone();
                            }
                            p.online = *online;
                            if rtt_ms.is_some() {
                                p.rtt_ms = *rtt_ms;
                            }
                        } else {
                            s.peers.push(PeerSnap {
                                peer_id: peer_id.clone(),
                                addr: addr.clone(),
                                online: *online,
                                rtt_ms: *rtt_ms,
                            });
                        }
                    }
                    _ => {}
                }
            }
            let _ = bus.send(event);
        }
    });

    tauri::async_runtime::spawn(net::drive(
        swarm,
        cmd_rx,
        out_tx.clone(),
        vec!["lobby".to_string()],
    ));

    if let Some(nick) = nick {
        handle.send(Cmd::Announce(nick));
    }

    if !stable {
        let _ = out_tx.send(Out::Notice {
            text: "port 4101 is busy, so this session uses a random port".into(),
        });
    }

    // Optional bootstrap: BLING_DIAL=/ip4/…/tcp/…/p2p/… (comma separated).
    if let Ok(list) = std::env::var("BLING_DIAL") {
        for addr in list.split(',').map(str::trim).filter(|a| !a.is_empty()) {
            handle.send(Cmd::Dial(addr.to_string()));
        }
    }

    *state.net.lock().map_err(|e| e.to_string())? = Some(handle);
    *state.peer_id.lock().map_err(|e| e.to_string())? = Some(peer_id.clone());

    Ok(Me { peer_id })
}

#[tauri::command]
fn bling_send(
    state: State<'_, AppState>,
    room: String,
    nick: String,
    text: String,
) -> Result<(), String> {
    state.with(|net| {
        net.send(Cmd::Publish { room, nick, text });
        Ok(())
    })
}

#[tauri::command]
fn bling_join(state: State<'_, AppState>, room: String) -> Result<(), String> {
    {
        let mut rooms = state.rooms.lock().map_err(|e| e.to_string())?;
        if !rooms.contains(&room) {
            rooms.push(room.clone());
        }
    }
    state.with(|net| {
        net.send(Cmd::Join(room));
        Ok(())
    })
}

#[tauri::command]
fn bling_leave(state: State<'_, AppState>, room: String) -> Result<(), String> {
    {
        let mut rooms = state.rooms.lock().map_err(|e| e.to_string())?;
        rooms.retain(|r| r != &room);
    }
    state.with(|net| {
        net.send(Cmd::Leave(room));
        Ok(())
    })
}

#[tauri::command]
fn bling_announce(state: State<'_, AppState>, nick: String) -> Result<(), String> {
    state.with(|net| {
        net.send(Cmd::Announce(nick));
        Ok(())
    })
}

#[tauri::command]
fn bling_open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http and https links open".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::PermissionState;
    let n = app.notification();
    let granted = matches!(n.permission_state(), Ok(PermissionState::Granted))
        || n.request_permission()
            .map(|s| s == PermissionState::Granted)
            .unwrap_or(false);
    if granted {
        let _ = n.builder().title(title).body(body).show();
    }
}

#[tauri::command]
fn bling_set_app_active(active: bool) {
    APP_ACTIVE.store(active, Ordering::Relaxed);
}

#[tauri::command]
fn bling_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    notify(&app, &title, &body);
    Ok(())
}

#[tauri::command]
fn bling_dial(state: State<'_, AppState>, addr: String) -> Result<(), String> {
    state.with(|net| {
        net.send(Cmd::Dial(addr));
        Ok(())
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (bus, _) = broadcast::channel::<Out>(512);
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(mobile)]
            {
                use tauri_plugin_notification::NotificationExt;
                let _ = _app.notification().request_permission();
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            net: Mutex::new(None),
            peer_id: Mutex::new(None),
            rooms: Mutex::new(Vec::new()),
            bus,
            snap: Arc::new(Mutex::new(Snapshot::default())),
        })
        .invoke_handler(tauri::generate_handler![
            bling_start,
            bling_send,
            bling_join,
            bling_leave,
            bling_announce,
            bling_open_url,
            bling_dial,
            bling_notify,
            bling_set_app_active
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bling");
}
