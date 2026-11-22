import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const ICONS = path.join(ROOT, "src-tauri", "icons");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: transparent; }
  .tile {
    width: 1024px; height: 1024px; box-sizing: border-box;
    border-radius: 232px;
    background: radial-gradient(120% 120% at 20% 15%, #2a1019 0%, #0E0A0D 55%, #0a0709 100%);
    display: grid; place-items: center;
    position: relative; overflow: hidden;
  }
  .glow-a { position: absolute; width: 760px; height: 760px; left: -220px; top: -260px;
    background: #D1305E; filter: blur(180px); opacity: .55; }
  .glow-b { position: absolute; width: 700px; height: 700px; right: -240px; bottom: -260px;
    background: #30D1A3; filter: blur(190px); opacity: .5; }
  .b {
    position: relative;
    font: 800 620px/1 -apple-system, "SF Pro Display", sans-serif;
    letter-spacing: -30px;
    padding-right: 34px;
    background: linear-gradient(135deg, #FF6B90 0%, #D1305E 45%, #30D1A3 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .dot { position: absolute; width: 96px; height: 96px; border-radius: 50%;
    background: #30D1A3; right: 236px; top: 250px; box-shadow: 0 0 60px #30D1A3; }
</style>
<div class="tile"><div class="glow-a"></div><div class="glow-b"></div><div class="b">b</div><div class="dot"></div></div>`;

fs.mkdirSync(ICONS, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: path.join(ICONS, "icon.png"), omitBackground: true });
await browser.close();

const { execFileSync } = await import("node:child_process");
const sips = (size, out) =>
  execFileSync("sips", ["-z", String(size), String(size), path.join(ICONS, "icon.png"), "--out", out]);

sips(32, path.join(ICONS, "32x32.png"));
sips(128, path.join(ICONS, "128x128.png"));
sips(256, path.join(ICONS, "128x128@2x.png"));
sips(512, path.join(ICONS, "icon-512.png"));

const iconset = path.join(ICONS, "icon.iconset");
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  sips(size, path.join(iconset, `icon_${size}x${size}.png`));
  sips(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(ICONS, "icon.icns")]);
fs.rmSync(iconset, { recursive: true, force: true });

// A minimal .ico container holding the 256px PNG (Windows bundling only).
fs.writeFileSync(path.join(ICONS, "icon.ico"), icoFromPng(fs.readFileSync(path.join(ICONS, "128x128@2x.png"))));
console.log("icons written to", ICONS);

function icoFromPng(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}
