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
let checks = 0;
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

const check = (label, ok) => {
  checks += 1;
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
      { id: "s0", from: peerB, nick: "robin", text: "yesterday's thread", ts: now - 26 * 60 * 60 * 1000, mine: false },
    ];
    localStorage.setItem(
      "bling.v1",
      JSON.stringify({ nick: "mira", rooms: ["lobby", "design"], current: "lobby", messages: { lobby: history } }),
    );

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => { window.__clip = text; } },
    });

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
            addrs: ["/ip4/192.168.1.42/tcp/4101", "/ip4/127.0.0.1/tcp/4101"],
          });
          emit({ type: "peer", peer_id: peerA, online: true, rtt_ms: 4, nick: "nadia" });
          emit({ type: "peer", peer_id: peerB, online: true, rtt_ms: 11, nick: "robin" });
        }, 30);
        return { peer_id: me };
      }
      if (cmd === "bling_send") return null;
      if (cmd === "bling_dial") return null;
      if (cmd === "bling_join") return null;
      if (cmd === "bling_leave") return null;
      if (cmd === "bling_qr")
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/></svg>';
      if (cmd === "bling_take_invites") return [];
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

// Presence: a nickname arrives before any message does.
await page.evaluate(({ peerB }) => {
  window.__chan.onmessage({ type: "nick", peer_id: peerB, nick: "robin" });
}, { peerB: PEER_B });
await new Promise((r) => setTimeout(r, 100));
check(
  "presence names a peer",
  (await page.$$eval(".peer .p-name", (n) => n.map((x) => x.textContent))).includes("robin"),
);
check("history renders five bubbles", (await page.$$eval(".msg", (n) => n.length)) === 5);
check(
  "day dividers split yesterday from today",
  (await page.$$eval(".day", (n) => n.map((x) => x.textContent))).join("|") === "Yesterday|Today",
);
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

// Links inside a message.
await page.evaluate(({ peerA }) => {
  window.__chan.onmessage({
    type: "message",
    id: "live-link",
    room: "lobby",
    from: peerA,
    nick: "nadia",
    text: "spec is at https://libp2p.io/docs, read it",
    ts: Date.now() + 10,
  });
}, { peerA: PEER_A });
await new Promise((r) => setTimeout(r, 150));
const link = await page.$eval(".msg:last-of-type .msg-bubble a.link", (a) => ({
  href: a.getAttribute("href"),
  text: a.textContent,
}));
check("a url in a message becomes a link", link.href === "https://libp2p.io/docs" && link.text === link.href);
check(
  "message text is selectable",
  (await page.$eval(".msg-bubble", (n) => getComputedStyle(n).userSelect)) === "text",
);
await page.click(".msg:last-of-type .msg-bubble a.link");
await new Promise((r) => setTimeout(r, 120));
const openCall = (await page.evaluate(() => window.__calls)).filter((c) => c.cmd === "bling_open_url").pop();
check("clicking a link asks the app to open it", openCall?.args.url === "https://libp2p.io/docs");

// Notices survive a redraw.
await page.evaluate(() => {
  window.__chan.onmessage({ type: "notice", text: "joined #lobby" });
  window.__chan.onmessage({
    type: "message",
    id: "after-notice",
    room: "lobby",
    from: "12D3KooWHm3vT8pLq5zR1cJdY6bN4xA2kS9uE0gW7fM5hQ3nD8yK",
    nick: "mira",
    text: "still here",
    ts: Date.now() + 20,
  });
});
await new Promise((r) => setTimeout(r, 200));
check("a notice stays in the transcript", (await page.$$eval(".notice", (n) => n.length)) >= 1);

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

// Scrolling: fill the room so it actually overflows.
await page.evaluate(({ peerB }) => {
  for (let i = 0; i < 24; i += 1) {
    window.__chan.onmessage({
      type: "message",
      id: `bulk-${i}`,
      room: "lobby",
      from: peerB,
      nick: "robin",
      text: `filler message number ${i} so the pane has to scroll`,
      ts: Date.now() + i,
    });
  }
}, { peerB: PEER_B });
await new Promise((r) => setTimeout(r, 300));
const atBottom = await page.evaluate(() => {
  const b = document.querySelector("#messages");
  return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight };
});
check("chat sticks to the newest message", atBottom.max > 0 && atBottom.top >= atBottom.max - 6);

await page.evaluate(() => { document.querySelector("#messages").scrollTop = 0; });
await page.evaluate(({ peerB }) => {
  window.__chan.onmessage({
    type: "message",
    id: "while-reading",
    room: "lobby",
    from: peerB,
    nick: "robin",
    text: "arrives while you are reading history",
    ts: Date.now() + 500,
  });
}, { peerB: PEER_B });
await new Promise((r) => setTimeout(r, 200));
check(
  "reading history is not yanked to the bottom",
  (await page.evaluate(() => document.querySelector("#messages").scrollTop)) < 60,
);
check("jump pill shows when scrolled up", !(await page.$eval("#jumpLatest", (n) => n.hidden)));
await page.click("#jumpLatest");
await new Promise((r) => setTimeout(r, 300));
check(
  "jump pill returns to the newest message",
  await page.evaluate(() => {
    const b = document.querySelector("#messages");
    return b.scrollTop >= b.scrollHeight - b.clientHeight - 6;
  }),
);

// Invites and pairing.
await page.click("#inviteBtn");
await new Promise((r) => setTimeout(r, 250));
check("invite opens the pair sheet", !(await page.$eval("#pairSheet", (n) => n.hidden)));
check("pair sheet draws a QR", await page.$eval("#pairQr", (n) => !!n.querySelector("svg")));
const pairLink = await page.$eval("#pairLink", (n) => n.textContent);
check(
  "pair sheet prints a valid invite link",
  (() => {
    try {
      const u = new URL(pairLink);
      return u.host === "join" && u.searchParams.get("room") === "lobby" && u.searchParams.get("addr").startsWith("/ip4/");
    } catch {
      return false;
    }
  })(),
);
check("pair sheet hides scan on desktop", await page.$eval("#pairScan", (n) => n.hidden));
await page.click("#pairCopy");
await new Promise((r) => setTimeout(r, 150));
const clip = await page.evaluate(() => window.__clip || "");
check(
  "copy link copies a bling:// invite with room and address",
  (() => {
    try {
      const u = new URL(clip);
      return u.searchParams.get("room") === "lobby" && u.searchParams.get("addr").includes("/p2p/");
    } catch {
      return false;
    }
  })(),
);
await page.click("#pairClose");
await new Promise((r) => setTimeout(r, 120));
check("pair sheet closes", await page.$eval("#pairSheet", (n) => n.hidden));

await page.$eval("#dialAddr", (n) => (n.value = ""));
await page.type("#dialAddr", `bling://design@/ip4/192.168.1.42/tcp/4101/p2p/${PEER_A}`);
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 150));
const dialCall = (await page.evaluate(() => window.__calls)).filter((c) => c.cmd === "bling_dial").pop();
check("invite dials the address it carries", dialCall?.args.addr === `/ip4/192.168.1.42/tcp/4101/p2p/${PEER_A}`);
check("invite opens the invited room", (await page.$eval("#roomTitle", (n) => n.textContent)) === "# design");

// Leaving a room.
await page.evaluate(() => {
  const row = [...document.querySelectorAll(".room-row")].find((r) => r.textContent.includes("build-log"));
  row?.querySelector(".room-del")?.click();
});
await new Promise((r) => setTimeout(r, 150));
check(
  "deleting a room removes it from the sidebar",
  await page.evaluate(() => ![...document.querySelectorAll(".room")].some((r) => r.textContent.includes("build-log"))),
);
const leaveCall = (await page.evaluate(() => window.__calls)).filter((c) => c.cmd === "bling_leave").pop();
check("deleting a room leaves the topic", leaveCall?.args.room === "build-log");
check("lobby has no delete button", await page.evaluate(() => {
  const row = [...document.querySelectorAll(".room-row")].find((r) => r.textContent.includes("lobby"));
  const del = row?.querySelector(".room-del");
  return !del || getComputedStyle(del).display === "none" || del.textContent === "×";
}));

// A reload must re-attach to the running swarm, not go blank.
await page.reload({ waitUntil: "networkidle0" });
await page.waitForFunction(() => (document.querySelector("#myAddr")?.dataset.addr || "").includes("/p2p/"), { timeout: 5000 });
check(
  "reload keeps the same listening address",
  (await page.$eval("#myAddr", (n) => n.dataset.addr)).startsWith("/ip4/192.168.1.42/tcp/4101/p2p/"),
);
check("reload keeps the saved rooms", (await page.$$eval(".room", (n) => n.length)) >= 2);

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
console.log(`\nPASS: ${checks} checks`);
