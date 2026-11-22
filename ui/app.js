const $ = (sel) => document.querySelector(sel);
const invoke = window.__TAURI__?.core?.invoke;
const Channel = window.__TAURI__?.core?.Channel;

const LS_KEY = "bling.v1";
const MAX_MEMORY = 300;

const state = {
  nick: "you",
  peerId: "",
  addrs: [],
  peers: new Map(),
  rooms: ["lobby"],
  current: "lobby",
  messages: {},
  unread: {},
  live: false,
};

function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    if (raw.nick) state.nick = raw.nick;
    if (Array.isArray(raw.rooms) && raw.rooms.length) state.rooms = raw.rooms;
    if (raw.current && state.rooms.includes(raw.current)) state.current = raw.current;
    if (raw.messages && typeof raw.messages === "object") state.messages = raw.messages;
  } catch {
    /* a corrupt cache is not worth a crash */
  }
}

function saveLocal() {
  const messages = {};
  for (const [room, list] of Object.entries(state.messages)) messages[room] = list.slice(-MAX_MEMORY);
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ nick: state.nick, rooms: state.rooms, current: state.current, messages }),
    );
  } catch {
    /* quota is a tomorrow problem */
  }
}

function shortId(id) {
  return id ? id.slice(-6) : "······";
}

function initials(name, id) {
  const n = (name || "").trim();
  if (n) return n.slice(0, 1).toUpperCase();
  return (shortId(id)[0] || "?").toUpperCase();
}

function hueFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

const AVATAR_PAIRS = [
  ["#ff7a9e", "#d1305e"],
  ["#6febc4", "#30d1a3"],
  ["#ffb3c6", "#b23a6b"],
  ["#30d1a3", "#1e8f72"],
  ["#ff9ab5", "#8a2b58"],
];

function avatarStyle(seed) {
  const [a, b] = AVATAR_PAIRS[hueFor(seed) % AVATAR_PAIRS.length];
  return `background: linear-gradient(135deg, ${a}, ${b});`;
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------------- rendering ---------------- */

function renderIdentity() {
  $("#myNick").textContent = state.nick;
  $("#myPeer").textContent = state.peerId ? `${state.peerId.slice(0, 10)}…${state.peerId.slice(-6)}` : "connecting…";
  $("#myAvatar").textContent = initials(state.nick, state.peerId);
  $("#railAvatar").textContent = initials(state.nick, state.peerId);
  document.title = `Bling · #${state.current}`;
}

function renderNetState() {
  const pill = $("#netState");
  pill.classList.toggle("off", !state.live);
  pill.querySelector("span").textContent = state.live ? "live" : "connecting";
  const online = [...state.peers.values()].filter((p) => p.online).length;
  $("#hintNet").textContent = online === 0 ? "waiting for peers" : `direct · ${online} ${online === 1 ? "peer" : "peers"}`;
}

function renderRooms() {
  const list = $("#roomList");
  list.innerHTML = "";
  const rail = $("#railRooms");
  rail.innerHTML = "";

  for (const room of state.rooms) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = `room${room === state.current ? " active" : ""}`;
    btn.innerHTML = '<span class="hash">#</span>';
    const label = document.createElement("span");
    label.textContent = room;
    btn.appendChild(label);
    const unread = state.unread[room] || 0;
    if (unread && room !== state.current) {
      const b = document.createElement("span");
      b.className = "unread";
      b.textContent = unread > 99 ? "99+" : String(unread);
      btn.appendChild(b);
    }
    btn.addEventListener("click", () => switchRoom(room));
    li.appendChild(btn);
    list.appendChild(li);

    const rb = document.createElement("button");
    rb.className = `rail-room${room === state.current ? " active" : ""}`;
    rb.title = `#${room}`;
    rb.textContent = (room[0] || "#").toUpperCase();
    if (unread && room !== state.current) {
      const b = document.createElement("span");
      b.className = "unread";
      b.textContent = unread > 9 ? "9+" : String(unread);
      rb.appendChild(b);
    }
    rb.addEventListener("click", () => switchRoom(room));
    rail.appendChild(rb);
  }

  $("#roomTitle").textContent = `# ${state.current}`;
  $("#input").placeholder = `Message #${state.current}`;
}

function renderPeers() {
  const list = $("#peerList");
  list.innerHTML = "";
  const peers = [...state.peers.values()]
    .filter((p) => p.online)
    .sort((a, b) => (a.nick || "").localeCompare(b.nick || "") || a.peer_id.localeCompare(b.peer_id));

  $("#peerCount").textContent = String(peers.length);
  $("#emptyPeers").hidden = peers.length > 0;

  for (const peer of peers) {
    const li = document.createElement("li");
    li.className = "peer";
    const av = document.createElement("div");
    av.className = "p-avatar";
    av.style.cssText = avatarStyle(peer.peer_id);
    av.textContent = initials(peer.nick, peer.peer_id);
    const text = document.createElement("div");
    text.style.minWidth = "0";
    const name = document.createElement("div");
    name.className = "p-name";
    name.textContent = peer.nick || `peer ${shortId(peer.peer_id)}`;
    const id = document.createElement("span");
    id.className = "p-id";
    id.textContent = shortId(peer.peer_id);
    text.append(name, id);
    const lat = document.createElement("span");
    lat.className = `p-latency${peer.rtt_ms == null ? " unknown" : ""}`;
    lat.textContent = peer.rtt_ms == null ? "·" : `${peer.rtt_ms}ms`;
    li.append(av, text, lat);
    list.appendChild(li);
  }
  renderNetState();
}

function pickAddr() {
  const usable = state.addrs.filter((a) => !a.includes("/ip4/0.0.0.0/") && !a.includes("/ip6/::/"));
  const lan = usable.find((a) => /\/ip4\/(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a) && a.includes("/tcp/"));
  const loop = usable.find((a) => a.includes("127.0.0.1") && a.includes("/tcp/"));
  const tcp = usable.find((a) => a.includes("/tcp/"));
  return lan || tcp || loop || usable[0] || "";
}

function renderAddr() {
  const addr = pickAddr();
  const btn = $("#myAddr");
  if (!addr) {
    btn.textContent = "finding…";
    return;
  }
  const dialable = state.peerId ? `${addr}/p2p/${state.peerId}` : addr;
  btn.textContent = addr;
  btn.title = `Click to copy ${dialable}`;
  btn.dataset.addr = dialable;
}

function renderMessages() {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.innerHTML = "";
  const list = state.messages[state.current] || [];

  if (list.length === 0) {
    const hero = document.createElement("div");
    hero.className = "hero";
    hero.innerHTML = `
      <div class="glyph">b</div>
      <h2>Quiet in #${state.current}.</h2>
      <p>Bling talks straight to other people's machines, no server in the middle.
      Open a second copy, or paste a multiaddr in the sidebar to connect by hand.</p>`;
    box.appendChild(hero);
    return;
  }

  let prev = null;
  for (const msg of list) {
    const mine = msg.mine || msg.from === state.peerId;
    const el = document.createElement("article");
    el.className = `msg${mine ? " mine" : ""}`;
    el.dataset.id = msg.id;

    if (
      prev &&
      prev.from === msg.from &&
      prev.mine === mine &&
      Math.abs(msg.ts - prev.ts) < 4 * 60 * 1000
    ) {
      el.classList.add("same-who");
    }

    const av = document.createElement("div");
    av.className = "msg-avatar";
    if (!mine) av.style.cssText = avatarStyle(msg.from || msg.nick || "anon");
    av.textContent = initials(msg.nick, msg.from);

    const col = document.createElement("div");
    col.className = "msg-col";
    const head = document.createElement("div");
    head.className = "msg-head";
    const who = document.createElement("span");
    who.className = "msg-who";
    who.textContent = mine ? state.nick : msg.nick || `peer ${shortId(msg.from)}`;
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = timeOf(msg.ts);
    head.append(who, time);

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = msg.text;

    col.append(head, bubble);
    el.append(av, col);
    box.appendChild(el);
    prev = { from: msg.from, mine, ts: msg.ts };
  }

  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function addNotice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  const dot = document.createElement("i");
  const span = document.createElement("span");
  span.textContent = text;
  el.append(dot, span);
  const box = $("#messages");
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ---------------- actions ---------------- */

function pushMessage(room, msg) {
  if (!state.messages[room]) state.messages[room] = [];
  const list = state.messages[room];
  if (msg.id && list.some((m) => m.id === msg.id)) return;
  list.push(msg);
  saveLocal();
  if (room === state.current) renderMessages();
}

function switchRoom(room) {
  if (!state.rooms.includes(room)) return;
  state.current = room;
  delete state.unread[room];
  saveLocal();
  renderRooms();
  renderMessages();
  renderIdentity();
  $("#input").focus();
}

function addRoom(raw) {
  const room = String(raw || "").trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9-]/g, "-").slice(0, 24);
  if (!room) return;
  if (!state.rooms.includes(room)) {
    state.rooms.push(room);
    invoke?.("bling_join", { room }).catch(() => {});
  }
  switchRoom(room);
}

function handlePeer(ev) {
  const cur = state.peers.get(ev.peer_id) || { peer_id: ev.peer_id, online: false, rtt_ms: null, addr: null };
  if (typeof ev.online === "boolean") cur.online = ev.online;
  if (ev.addr) cur.addr = ev.addr;
  if (ev.nick) cur.nick = ev.nick;
  if (ev.rtt_ms != null) cur.rtt_ms = ev.rtt_ms;
  state.peers.set(ev.peer_id, cur);
  renderPeers();
}

function handleEvent(ev) {
  switch (ev.type) {
    case "ready":
      state.peerId = ev.peer_id;
      state.live = true;
      renderIdentity();
      renderAddr();
      renderNetState();
      break;
    case "listening":
      state.addrs = ev.addrs || [];
      renderAddr();
      break;
    case "peer":
      handlePeer(ev);
      break;
    case "message": {
      if (ev.from === state.peerId) break;
      const peer = state.peers.get(ev.from);
      if (peer && ev.nick) {
        peer.nick = ev.nick;
        renderPeers();
      }
      const msg = { id: ev.id, from: ev.from, nick: ev.nick, text: ev.text, ts: ev.ts, mine: false };
      pushMessage(ev.room, msg);
      if (ev.room !== state.current) {
        state.unread[ev.room] = (state.unread[ev.room] || 0) + 1;
        renderRooms();
      }
      break;
    }
    case "notice":
      toast(ev.text);
      break;
    default:
      break;
  }
}

async function start() {
  if (!invoke || !Channel) {
    $("#netState").querySelector("span").textContent = "no bridge";
    $("#hintNet").textContent = "preview mode";
    return;
  }
  try {
    const channel = new Channel();
    channel.onmessage = handleEvent;
    const me = await invoke("bling_start", { channel });
    state.peerId = me.peer_id;
    state.live = true;
    renderIdentity();
    renderNetState();
  } catch (err) {
    $("#netState").querySelector("span").textContent = "offline";
    toast(`swarm failed: ${err}`, "warn");
  }
}

/* ---------------- wiring ---------------- */

function autosize() {
  const el = $("#input");
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  $("#send").disabled = !el.value.trim();
}

async function send() {
  const el = $("#input");
  const text = el.value.trim();
  if (!text) return;
  const msg = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: state.peerId,
    nick: state.nick,
    text,
    ts: Date.now(),
    mine: true,
  };
  el.value = "";
  autosize();
  pushMessage(state.current, msg);
  try {
    await invoke?.("bling_send", { room: state.current, nick: state.nick, text });
  } catch (err) {
    toast(`not sent: ${err}`, "warn");
  }
}

function editNick() {
  const btn = $("#myNick");
  if (document.querySelector("#nickInput")) return;
  const input = document.createElement("input");
  input.id = "nickInput";
  input.value = state.nick;
  input.maxLength = 24;
  input.style.cssText =
    "width:100%;background:var(--bg);border:1px solid rgba(48,209,163,.45);border-radius:7px;padding:3px 7px;font-size:13px;outline:none;";
  btn.replaceWith(input);
  input.focus();
  input.select();
  let closed = false;
  const done = (commit) => {
    if (closed) return;
    closed = true;
    if (commit && input.value.trim()) state.nick = input.value.trim();
    if (input.parentNode) input.replaceWith(btn);
    renderIdentity();
    saveLocal();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  input.addEventListener("blur", () => done(true));
}

async function copy(text, note) {
  try {
    await navigator.clipboard.writeText(text);
    toast(note);
  } catch {
    toast("could not reach the clipboard", "warn");
  }
}

function wire() {
  $("#send").addEventListener("click", send);

  $("#input").addEventListener("input", autosize);
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $("#myNick").addEventListener("click", editNick);

  $("#myPeer").addEventListener("click", () => {
    if (state.peerId) copy(state.peerId, "peer id copied");
  });

  $("#myAddr").addEventListener("click", () => {
    const addr = $("#myAddr").dataset.addr;
    if (addr) copy(addr, "address copied, send it to a friend");
  });

  $("#addRoomBtn").addEventListener("click", () => {
    const form = $("#newRoomForm");
    form.hidden = !form.hidden;
    if (!form.hidden) $("#newRoomName").focus();
  });

  $("#newRoomForm").addEventListener("submit", (e) => {
    e.preventDefault();
    addRoom($("#newRoomName").value);
    $("#newRoomName").value = "";
    $("#newRoomForm").hidden = true;
  });

  $("#dialForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const addr = $("#dialAddr").value.trim();
    if (!addr) return;
    if (!addr.startsWith("/")) {
      toast("that is not a multiaddr", "warn");
      return;
    }
    try {
      await invoke("bling_dial", { addr });
      $("#dialAddr").value = "";
    } catch (err) {
      toast(String(err), "warn");
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".rail-room")) return;
  });
}

loadLocal();
renderRooms();
renderIdentity();
renderPeers();
renderMessages();
wire();
autosize();
$("#input").focus();
start();
