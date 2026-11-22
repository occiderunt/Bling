import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const UI = path.join(ROOT, "ui");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
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
await new Promise((r) => server.listen(4404, r));

const PEER_A = "12D3KooWQp7nJ2sVx9mH4tLbR8eYc3aF6kD1uW5zN0gS7hK2mX9v";
const PEER_B = "12D3KooWBk4aL9dRy2uT6cQsP1mVh8nE3jZ5xG0wF7rC4bN9tH2";
const ME = "12D3KooWHm3vT8pLq5zR1cJdY6bN4xA2kS9uE0gW7fM5hQ3nD8yK";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 780 });

const errors = [];
const failures = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

const check = (label, ok) => {
  if (!ok) failures.push(label);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

await page.evaluateOnNewDocument(
  ({ me, peerA, peerB }) => {
    const now = Date.now();
    const history = [
      { id: "s1", from: peerA, nick: "nadia", text: "rose is loud, mint is quiet", ts: now - 300000, mine: false },
      { id: "s2", from: me, nick: "mira", text: "that's the brand", ts: now - 260000, mine: true },
      { id: "s3", from: peerB, nick: "robin", text: "4ms on the same wifi", ts: now - 200000, mine: false },
      { id: "s4", from: me, nick: "mira", text: "now try it off-network", ts: now - 160000, mine: true },
    ];
    localStorage.setItem(
      "bling.v1",
      JSON.stringify({ nick: "mira", rooms: ["lobby", "design"], current: "lobby", messages: { lobby: history } }),
    );

    class FakeChannel {
      constructor() {
        window.__chan = this;
      }
      send() {}
    }
    window.__calls = [];
    const invoke = async (cmd, args) => {
      window.__calls.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) });
      if (cmd === "bling_start") {
        setTimeout(() => {
          const ch = window.__chan;
          const emit = (e) => ch?.onmessage?.(e);
          emit({ type: "ready", peer_id: me });
          emit({
            type: "listening",
            addrs: ["/ip4/192.168.1.42/tcp/51833", "/ip4/127.0.0.1/tcp/51833"],
          });
          emit({ type: "peer", peer_id: peerA, online: true, rtt_ms: 4, nick: "nadia" });
          emit({ type: "peer", peer_id: peerB, online: true, rtt_ms: 11, nick: "robin" });
        }, 30);
        return { peer_id: me };
      }
      if (cmd === "bling_send") return null;
      if (cmd === "bling_dial") return null;
      if (cmd === "bling_join") return null;
      return null;
    };
    window.__TAURI__ = { core: { invoke, Channel: FakeChannel } };
  },
  { me: ME, peerA: PEER_A, peerB: PEER_B },
);

await page.goto("http://localhost:4404/", { waitUntil: "networkidle0" });
await page.waitForSelector(".msg");
await new Promise((r) => setTimeout(r, 250));

check("app renders the wordmark", (await page.$eval(".wordmark", (n) => n.textContent)) === "Bling");
check("identity shows my nickname", (await page.$eval("#myNick", (n) => n.textContent)) === "mira");
check(
  "identity shows a peer id",
  (await page.$eval("#myPeer", (n) => n.textContent)).includes("12D3Koo"),
);
check("status pill goes live", (await page.$eval("#netState span", (n) => n.textContent)) === "live");
check("peer count is 2", (await page.$eval("#peerCount", (n) => n.textContent)) === "2");
check(
  "peer names come from presence",
  (await page.$$eval(".peer .p-name", (n) => n.map((x) => x.textContent))).join(",") === "nadia,robin",
);
check("latency shows for a peer", (await page.$$eval(".peer .p-latency", (n) => n.map((x) => x.textContent))).includes("4ms"));
check("history renders four bubbles", (await page.$$eval(".msg", (n) => n.length)) === 4);
check("my messages are right aligned", (await page.$$eval(".msg.mine", (n) => n.length)) === 2);
check(
  "address is dialable with a peer id",
  (await page.$eval("#myAddr", (n) => n.dataset.addr || "")).includes("/p2p/12D3Koo"),
);

// Sending.
const before = await page.$$eval(".msg", (n) => n.length);
await page.type("#input", "hello from the test");
await page.keyboard.press("Enter");
await page.waitForFunction((n) => document.querySelectorAll(".msg").length === n + 1, {}, before);
check("sending appends my message", (await page.$eval(".msg:last-of-type", (n) => n.className)).includes("mine"));
const sendCall = (await page.evaluate(() => window.__calls)).filter((c) => c.cmd === "bling_send").pop();
check("send reaches the swarm with room, nick and text", sendCall?.args.room === "lobby" && sendCall?.args.nick === "mira" && sendCall?.args.text === "hello from the test");
check("composer clears after send", (await page.$eval("#input", (n) => n.value)) === "");

// Incoming message from another peer.
await page.evaluate(
  ({ peerA }) => {
    window.__chan.onmessage({
      type: "message",
      id: "live-1",
      room: "lobby",
      from: peerA,
      nick: "nadia",
      text: "got it over here",
      ts: Date.now(),
    });
  },
  { peerA: PEER_A },
);
await new Promise((r) => setTimeout(r, 120));
check(
  "incoming message renders in the list",
  (await page.$$eval(".msg", (n) => n.length)) === before + 2,
);

// Rooms.
await page.click("#addRoomBtn");
await page.type("#newRoomName", "Build Log");
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 120));
check("new room is created", (await page.$eval("#roomTitle", (n) => n.textContent)) === "# build-log");
check("new room switches the view", (await page.$$eval(".msg", (n) => n.length)) === 0);
const joinCall = (await page.evaluate(() => window.__calls)).filter((c) => c.cmd === "bling_join").pop();
check("new room is joined on the swarm", joinCall?.args.room === "build-log");
check("empty room shows the hero", (await page.$$(".hero")).length === 1);

await page.evaluate(
  ({ peerB }) => {
    window.__chan.onmessage({
      type: "message",
      id: "live-2",
      room: "lobby",
      from: peerB,
      nick: "robin",
      text: "anyone there",
      ts: Date.now(),
    });
  },
  { peerB: PEER_B },
);
await new Promise((r) => setTimeout(r, 120));
check("unread badge appears on the other room", (await page.$$(".room .unread")).length === 1);

await page.evaluate(() => {
  [...document.querySelectorAll(".room")].find((b) => b.textContent.includes("lobby"))?.click();
});
await new Promise((r) => setTimeout(r, 120));
check("switching back clears the badge", (await page.$$(".room .unread")).length === 0);

// Rename.
await page.click("#myNick");
await page.$eval("#nickInput", (n) => (n.value = ""));
await page.type("#nickInput", "aurora");
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 100));
check("rename updates the identity", (await page.$eval("#myNick", (n) => n.textContent)) === "aurora");
const storedNick = await page.evaluate(() => JSON.parse(localStorage.getItem("bling.v1")).nick);
check("rename persists", storedNick === "aurora");

// Layout.
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check("no horizontal overflow at 1180", overflow <= 0);
await page.setViewport({ width: 900, height: 700 });
await new Promise((r) => setTimeout(r, 150));
const overflowSmall = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check("no horizontal overflow at 900", overflowSmall <= 0);

check("no console errors", errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
server.close();

if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log(`\nPASS: 22 checks`);
