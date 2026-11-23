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
  notices: {},
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
    li.className = "room-row";
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

    const del = document.createElement("button");
    del.className = "room-del";
    del.title = `leave #${room}`;
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeRoom(room);
    });

    li.append(btn, del);
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

let paintedRoom = null;

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

function scrollToEnd(box = $("#messages")) {
  box.scrollTo({ top: box.scrollHeight, behavior: "instant" });
}

function updateJump() {
  const box = $("#messages");
  const far = box.scrollHeight - box.scrollTop - box.clientHeight > 140;
  $("#jumpLatest").hidden = !far || Boolean(box.querySelector(".hero"));
}

function dayKey(ts) {
  return new Date(ts).toDateString();
}

function dayLabel(ts) {
  const now = new Date();
  const then = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const days = Math.round((today - that) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return then.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function dayDivider(ts) {
  const el = document.createElement("div");
  el.className = "day";
  el.textContent = dayLabel(ts);
  return el;
}

function fillText(el, text) {
  let at = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > at) el.appendChild(document.createTextNode(text.slice(at, match.index)));
    const raw = match[0];
    const tail = (raw.match(/[.,!?;:)\]]+$/) || [""])[0];
    const href = tail ? raw.slice(0, -tail.length) : raw;
    const a = document.createElement("a");
    a.className = "link";
    a.href = href;
    a.textContent = href;
    a.title = href;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (invoke) invoke("bling_open_url", { url: href }).catch((err) => toast(String(err), "warn"));
      else window.open(href, "_blank", "noopener");
    });
    el.appendChild(a);
    if (tail) el.appendChild(document.createTextNode(tail));
    at = match.index + raw.length;
  }
  if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
  if (!el.childNodes.length) el.textContent = text;
}

function renderMessages(forceBottom = false) {
  const box = $("#messages");
  const firstPaint = paintedRoom !== state.current;
  const stick =
    forceBottom || firstPaint || box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  const prevTop = box.scrollTop;

  box.innerHTML = "";
  const list = state.messages[state.current] || [];
  const notices = state.notices[state.current] || [];

  if (list.length === 0 && notices.length === 0) {
    const hero = document.createElement("div");
    hero.className = "hero";
    hero.innerHTML = `
      <div class="glyph">b</div>
      <h2>Quiet in #${state.current}.</h2>
      <p>Bling talks straight to other people's machines, no server in the middle.
      Open a second copy, or paste a multiaddr in the sidebar to connect by hand.</p>`;
    box.appendChild(hero);
    paintedRoom = state.current;
    updateJump();
    return;
  }

  const items = [
    ...list.map((m) => ({ kind: "msg", ts: m.ts, m })),
    ...notices.map((n) => ({ kind: "notice", ts: n.ts, n })),
  ].sort((a, b) => a.ts - b.ts);

  let prev = null;
  let lastDay = null;

  for (const item of items) {
    const day = dayKey(item.ts);
    if (day !== lastDay) {
      box.appendChild(dayDivider(item.ts));
      lastDay = day;
      prev = null;
    }

    if (item.kind === "notice") {
      const el = document.createElement("div");
      el.className = "notice";
      const dot = document.createElement("i");
      const span = document.createElement("span");
      span.textContent = item.n.text;
      el.append(dot, span);
      box.appendChild(el);
      prev = null;
      continue;
    }

    const msg = item.m;
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
    fillText(bubble, msg.text);

    col.append(head, bubble);
    el.append(av, col);
    box.appendChild(el);
    prev = { from: msg.from, mine, ts: msg.ts };
  }

  paintedRoom = state.current;
  if (stick) scrollToEnd(box);
  else box.scrollTop = prevTop;
  updateJump();
}

function addNotice(text) {
  const room = state.current;
  if (!state.notices[room]) state.notices[room] = [];
  state.notices[room].push({ text, ts: Date.now() });
  if (state.notices[room].length > 40) state.notices[room].shift();
  renderMessages();
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

function closeDrawer() {
  const side = document.querySelector(".side");
  side.classList.remove("open");
  const scrim = $("#scrim");
  if (scrim) scrim.hidden = true;
}

function switchRoom(room) {
  if (!state.rooms.includes(room)) return;
  closeDrawer();
  state.current = room;
  delete state.unread[room];
  saveLocal();
  renderRooms();
  renderMessages(true);
  renderIdentity();
  $("#input").focus();
}

function removeRoom(room) {
  if (room === "lobby") {
    toast("lobby always stays", "warn");
    return;
  }
  const idx = state.rooms.indexOf(room);
  if (idx < 0) return;
  state.rooms.splice(idx, 1);
  delete state.messages[room];
  delete state.unread[room];
  invoke?.("bling_leave", { room }).catch(() => {});
  if (state.current === room) state.current = "lobby";
  saveLocal();
  renderRooms();
  renderMessages(true);
  renderIdentity();
  toast(`left #${room}`);
}

function cleanRoom(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 24);
}

// A real URL needs a host, so the invite is bling://join?room=…&addr=…
// Older builds handed out bling://room@multiaddr; keep reading those.
function inviteLink(room = state.current) {
  const addr = $("#myAddr").dataset.addr;
  if (!addr) return null;
  return `bling://join?room=${encodeURIComponent(room)}&addr=${encodeURIComponent(addr)}`;
}

function parseInvite(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("bling://")) return null;

  let url = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (url && url.host === "join") {
    const room = cleanRoom(url.searchParams.get("room"));
    const addr = (url.searchParams.get("addr") || "").trim();
    if (!room || !addr.startsWith("/")) return null;
    return { room, addr };
  }

  const at = text.indexOf("@", 8);
  if (at < 0) return null;
  const room = cleanRoom(text.slice(8, at));
  const addr = text.slice(at + 1).trim();
  if (!room || !addr.startsWith("/")) return null;
  return { room, addr };
}

function isMobile() {
  return /Android|iPhone|iPad/i.test(navigator.userAgent);
}

async function dialInvite(invite) {
  try {
    await invoke("bling_dial", { addr: invite.addr });
    addRoom(invite.room);
    toast(`joined #${invite.room}`);
    return true;
  } catch (err) {
    toast(String(err), "warn");
    return false;
  }
}

let lastInvite = { url: "", at: 0 };

function handleInviteUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return;
  // The launch link reaches us twice (plugin state and Rust's pending queue).
  if (text === lastInvite.url && Date.now() - lastInvite.at < 8000) return;
  lastInvite = { url: text, at: Date.now() };
  const invite = parseInvite(text);
  if (!invite) {
    toast("that link is not something I can read", "warn");
    return;
  }
  dialInvite(invite);
}

async function openPairSheet() {
  const link = inviteLink();
  if (!link) {
    toast("still working out my address", "warn");
    return;
  }
  $("#pairSheet").hidden = false;
  $("#pairLink").textContent = link;
  if (isMobile()) $("#pairScan").hidden = false;

  const qr = $("#pairQr");
  qr.classList.remove("failed");
  qr.textContent = "";
  try {
    const svg = await invoke("bling_qr", { text: link });
    if (typeof svg !== "string" || !svg.includes("<svg")) throw new Error("no code");
    qr.innerHTML = svg;
  } catch {
    qr.classList.add("failed");
    qr.textContent = "could not draw a code here";
  }
}

function closePairSheet() {
  $("#pairSheet").hidden = true;
}

async function scanInvite() {
  try {
    const asked = await invoke("plugin:barcode-scanner|request_permissions");
    if (asked && asked.camera && asked.camera !== "granted") {
      toast("the camera is off for Bling", "warn");
      return;
    }
    const hit = await invoke("plugin:barcode-scanner|scan", {
      formats: ["QR_CODE"],
      windowed: false,
      cameraDirection: "back",
    });
    const text = typeof hit === "string" ? hit : hit?.content;
    if (!text) return;
    closePairSheet();
    handleInviteUrl(text);
  } catch (err) {
    const detail = String(err || "");
    if (!/cancel/i.test(detail)) toast(detail || "could not scan", "warn");
  }
}

// Links that launched the app, plus any that arrive while it is running.
async function initLinks() {
  const seen = new Set();
  // On Android the launch link only exists once the webview has loaded, so ask
  // the plugin directly rather than relying on what Rust saw during setup.
  try {
    const current = await invoke("plugin:deep-link|get_current");
    if (current?.url) seen.add(current.url);
  } catch {
    /* desktop builds without a link, or no plugin */
  }
  try {
    const urls = await invoke("bling_take_invites");
    if (Array.isArray(urls)) urls.forEach((url) => seen.add(url));
  } catch {
    /* carry on with what we have */
  }
  for (const url of seen) handleInviteUrl(url);

  try {
    await window.__TAURI__?.event?.listen("bling:invite", (e) => handleInviteUrl(e.payload));
  } catch {
    /* no event bridge, no problem */
  }
}

function addRoom(raw) {
  const room = cleanRoom(raw);
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
    case "nick": {
      const cur = state.peers.get(ev.peer_id) || {
        peer_id: ev.peer_id,
        online: false,
        rtt_ms: null,
        addr: null,
      };
      cur.nick = ev.nick;
      state.peers.set(ev.peer_id, cur);
      renderPeers();
      break;
    }
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
      addNotice(ev.text);
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
    const me = await invoke("bling_start", { channel, nick: state.nick });
    state.peerId = me.peer_id;
    state.live = true;
    renderIdentity();
    renderNetState();
    for (const room of state.rooms) invoke("bling_join", { room }).catch(() => {});
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
    if (commit && input.value.trim()) {
      state.nick = input.value.trim();
      invoke?.("bling_announce", { nick: state.nick }).catch(() => {});
    }
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

  $("#inviteBtn").addEventListener("click", () => openPairSheet());
  $("#pairBtn").addEventListener("click", () => openPairSheet());
  $("#pairClose").addEventListener("click", () => closePairSheet());
  $("#pairSheet").addEventListener("click", (e) => {
    if (e.target === $("#pairSheet")) closePairSheet();
  });
  $("#pairCopy").addEventListener("click", () => {
    const link = $("#pairLink").textContent;
    if (link) copy(link, `invite to #${state.current} copied`);
  });
  $("#pairScan").addEventListener("click", () => scanInvite());
  $("#scanBtn").addEventListener("click", () => scanInvite());

  $("#jumpLatest").addEventListener("click", () => scrollToEnd());

  $("#messages").addEventListener("scroll", updateJump);

  $("#newRoomName").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("#newRoomForm").hidden = true;
    }
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
    const raw = $("#dialAddr").value.trim();
    if (!raw) return;
    const invite = parseInvite(raw);
    const addr = invite ? invite.addr : raw;
    if (!addr.startsWith("/")) {
      toast("that is not a multiaddr or invite", "warn");
      return;
    }
    const ok = invite
      ? await dialInvite(invite)
      : await invoke("bling_dial", { addr }).then(
          () => true,
          (err) => {
            toast(String(err), "warn");
            return false;
          },
        );
    if (ok) $("#dialAddr").value = "";
  });

  const menu = $("#mobileMenu");
  if (menu) {
    menu.addEventListener("click", () => {
      const side = document.querySelector(".side");
      const open = side.classList.toggle("open");
      $("#scrim").hidden = !open;
    });
  }
  const scrim = $("#scrim");
  if (scrim) scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".rail-room")) return;
  });
}

// Tell Rust whether the app is actually on screen; notifications only fire
// when it is not. window focus alone is unreliable on Android.
function reportAppActive() {
  invoke?.("bling_set_app_active", { active: !document.hidden }).catch(() => {});
}
document.addEventListener("visibilitychange", reportAppActive);
window.addEventListener("focus", reportAppActive);
window.addEventListener("blur", reportAppActive);
reportAppActive();

loadLocal();
renderRooms();
renderIdentity();
renderPeers();
renderMessages();
wire();
initLinks();
if (isMobile()) {
  const scan = $("#scanBtn");
  if (scan) scan.hidden = false;
  const pair = $("#pairBtn");
  if (pair) pair.hidden = false;
}
autosize();
$("#input").focus();
start();
