# Bling

A peer-to-peer chat app. Rose `#D1305E` and mint `#30D1A3` on near-black.

Messages travel machine to machine over libp2p. There is no server, no account,
no message store in the middle.

![Bling talking to a peer](shots/04-live-peer.png)

## Download

Grab the latest build from [Releases](https://github.com/occiderunt/Bling/releases).

- **macOS** (Apple silicon): open the `.dmg`, drag Bling to Applications. The
  build is ad-hoc signed, so on first launch use right-click → Open, or run
  `xattr -dr com.apple.quarantine /Applications/Bling.app`.
- **Windows**: run the `-setup.exe`.

Both platforms are built by GitHub Actions from the tag, every release.

## Stack

- Tauri 2 shell with a plain HTML/CSS/JS webview (no bundler).
- Rust backend (`src-tauri/src/net.rs`) owns the swarm. The webview never makes
  a network call; it talks to Rust over Tauri commands and one event channel.
- libp2p 0.57:
  - gossipsub, one topic per room: `bling/room/<name>`
  - noise + yamux over TCP, plus QUIC
  - identify, ping, mDNS for local discovery
  - ed25519 identity persisted in the app data dir, so your peer id is stable

## Build it yourself

```bash
npm install
npm run tauri build -- --bundles app   # or dmg / nsis
```

Dev binaries:

```bash
cd src-tauri
cargo run --bin bling           # the app
cargo run --bin twonode         # two nodes in one process, asserts delivery
cargo run --bin bot -- --listen # a throwaway peer that chats after you dial it
```

The app listens on TCP and QUIC and shows its dialable address in the sidebar.
Two ways to connect:

1. **mDNS**: peers on the same network appear by themselves. On macOS the app
   needs Local Network permission for this.
2. **Paste a multiaddr**: copy `/ip4/<ip>/tcp/<port>/p2p/<peer-id>` from one
   instance into the other's sidebar. This always works, including over
   loopback.

`BLING_DATA=/tmp/whatever cargo run --bin bling` gives an instance its own
identity, and `BLING_DIAL=/ip4/.../p2p/...` auto-dials a peer at startup.

## Checks

```bash
node scripts/smoke.mjs   # 22 UI checks against a mocked bridge
node scripts/shot.mjs    # screenshots into shots/
cargo run --bin twonode  # 8 networking checks on real sockets
```

## Known gaps

- No store-and-forward: if the other person is offline, the message is gone.
  A relay or mailbox node is the next real piece of work.
- Rooms are gossipsub topics, so anyone who knows the name can join. No invite
  or capability model yet.
- History lives in the webview's localStorage per device, capped at 300
  messages per room.
- Transport is encrypted and signed by libp2p (noise + gossipsub strict
  validation), but payloads are plain JSON, not a sealed E2E format.
- Ping latency shows `0ms` over loopback; that is honest, not a bug.

## License

MIT
