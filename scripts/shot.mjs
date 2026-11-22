import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const UI = path.join(ROOT, "ui");
const OUT = process.argv[2] || path.join(ROOT, "shots");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let file = path.join(UI, decodeURIComponent(url.pathname));
  if (url.pathname === "/" || !path.extname(file)) file = path.join(UI, "index.html");
  if (!file.startsWith(UI) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(4402, r));
fs.mkdirSync(OUT, { recursive: true });

const PEER_A = "12D3KooWQp7nJ2sVx9mH4tLbR8eYc3aF6kD1uW5zN0gS7hK2mX9v";
const PEER_B = "12D3KooWBk4aL9dRy2uT6cQsP1mVh8nE3jZ5xG0wF7rC4bN9tH2";
const ME = "12D3KooWHm3vT8pLq5zR1cJdY6bN4xA2kS9uE0gW7fM5hQ3nD8yK";

/** Seed history + a fake Tauri bridge so the real UI renders outside the app. */
function seed({ nick = "mira", messages = [], peers = [], me = "", peerA = "" } = {}) {
  const empty = location.search.includes("empty");
  const now = Date.now();
  const history = messages.map((m, i) => ({
    id: `seed-${i}`,
    from: m.me ? me : m.from || peerA,
    nick: m.me ? nick : m.nick || "nadia",
    text: m.text,
    ts: now - (messages.length - i) * 47000,
    mine: !!m.me,
  }));
  const store = {
    nick,
    rooms: ["lobby", "design"],
    current: "lobby",
    messages: { lobby: history },
  };
  try {
    if (empty) localStorage.removeItem("bling.v1");
    else localStorage.setItem("bling.v1", JSON.stringify(store));
  } catch {}

  class FakeChannel {
    constructor() {
      window.__chan = this;
    }
    send() {}
  }
  const invoke = async (cmd, args) => {
    window.__calls = window.__calls || [];
    window.__calls.push({ cmd, args: { ...(args || {}), channel: undefined } });
    if (cmd === "bling_start") {
      setTimeout(() => {
        const ch = window.__chan;
        const emit = (e) => ch && ch.onmessage && ch.onmessage(e);
        emit({ type: "ready", peer_id: me });
        emit({
          type: "listening",
          addrs: [
            "/ip4/192.168.1.42/tcp/4101",
            "/ip4/127.0.0.1/tcp/4101",
            "/ip4/192.168.1.42/udp/4101/quic-v1",
          ],
        });
        for (const p of peers) {
          emit({ type: "peer", peer_id: p.id, addr: p.addr || null, online: true, rtt_ms: p.rtt ?? null, nick: p.nick });
        }
      }, 40);
      return { peer_id: me };
    }
    return null;
  };
  window.__TAURI__ = { core: { invoke, Channel: FakeChannel } };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--hide-scrollbars", "--force-device-scale-factor=2"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 780, deviceScaleFactor: 2 });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.evaluateOnNewDocument(seed, {
  nick: "mira",
  me: ME,
  peerA: PEER_A,
  peers: [
    { id: PEER_A, rtt: 4, nick: "nadia" },
    { id: PEER_B, rtt: 11, nick: "robin" },
  ],
  messages: [
    { nick: "nadia", text: "ok the rose is loud and the mint is quiet. I like it." },
    { me: true, text: "that's the whole brand basically" },
    { nick: "nadia", text: "so where does the traffic actually go?" },
    { me: true, text: "straight to her machine. gossipsub over noise, nothing sitting in the middle." },
    { nick: "robin", from: PEER_B, text: "tested it across two laptops on the same wifi. 4ms round trip." },
    { me: true, text: "that's local. try it off-network tomorrow and we'll talk relays." },
  ],
});

await page.goto("http://localhost:4402/", { waitUntil: "networkidle0" });
await page.waitForSelector(".msg");
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: path.join(OUT, "01-chat.png") });

// Empty state: a fresh install with nothing to say yet.
await page.evaluate(() => {
  localStorage.removeItem("bling.v1");
});
await page.goto("http://localhost:4402/?empty=1", { waitUntil: "networkidle0" });
await page.waitForSelector(".hero");
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: path.join(OUT, "02-empty.png") });

if (errors.length) {
  console.error("console errors:", errors);
  process.exitCode = 1;
}
console.log("shots in", OUT);
await browser.close();
server.close();
