#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;

use bling::net::{self, Cmd, Net, Out};
use serde::Serialize;
use tauri::{ipc::Channel, Manager, State};

struct AppState {
    net: Mutex<Option<Net>>,
    peer_id: Mutex<Option<String>>,
}

impl AppState {
    fn with(&self, f: impl FnOnce(&Net) -> Result<(), String>) -> Result<(), String> {
        let slot = self.net.lock().map_err(|e| e.to_string())?;
        match slot.as_ref() {
            Some(net) => f(net),
            None => Err("swarm is not running".into()),
        }
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
) -> Result<Me, String> {
    if let Some(peer_id) = state.peer_id.lock().map_err(|e| e.to_string())?.clone() {
        return Ok(Me { peer_id });
    }

    let dir = match std::env::var("BLING_DATA") {
        Ok(path) => PathBuf::from(path),
        Err(_) => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = net::load_or_create_key(&dir.join("identity.key"))?;

    let (handle, swarm, cmd_rx) = net::create(
        key,
        &["/ip4/0.0.0.0/tcp/0", "/ip4/0.0.0.0/udp/0/quic-v1"],
    )?;
    let peer_id = handle.peer_id.to_string();

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Out>();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = out_rx.recv().await {
            if channel.send(event).is_err() {
                break;
            }
        }
    });
    tauri::async_runtime::spawn(net::drive(
        swarm,
        cmd_rx,
        out_tx,
        vec!["lobby".to_string()],
    ));

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
    state.with(|net| {
        net.send(Cmd::Join(room));
        Ok(())
    })
}

#[tauri::command]
fn bling_dial(state: State<'_, AppState>, addr: String) -> Result<(), String> {
    state.with(|net| {
        net.send(Cmd::Dial(addr));
        Ok(())
    })
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            net: Mutex::new(None),
            peer_id: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            bling_start,
            bling_send,
            bling_join,
            bling_dial
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bling");
}
