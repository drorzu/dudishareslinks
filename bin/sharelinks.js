#!/usr/bin/env node
"use strict";

/**
 * sharelinks — a single home for all your generated HTML reports.
 *
 * It keeps a local library of every HTML file you publish, groups them by
 * theme into one gallery page, and pushes the whole thing live to Surge.sh
 * (a static host whose account creation + auth work entirely from the CLI —
 * no browser, no signup page, free).
 *
 * Zero npm dependencies: uses Node built-ins + `npx surge` for deploys.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// Paths & storage
// ---------------------------------------------------------------------------

const ROOT = process.env.SHARELINKS_HOME || path.join(os.homedir(), ".sharelinks");
const CONFIG_PATH = path.join(ROOT, "config.json");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const SOURCES_DIR = path.join(ROOT, "sources"); // stored copies of published html
const BUILD_DIR = path.join(ROOT, "site"); // regenerated deployable output

const SURGE_ENDPOINT = "https://surge.surge.sh";

function ensureDirs() {
  for (const d of [ROOT, SOURCES_DIR]) fs.mkdirSync(d, { recursive: true });
}

function loadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  return loadJSON(CONFIG_PATH, {});
}

function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  try {
    fs.chmodSync(CONFIG_PATH, 0o600); // holds the surge token + password
  } catch {}
}

function loadManifest() {
  return loadJSON(MANIFEST_PATH, { items: [] });
}

function saveManifest(m) {
  ensureDirs();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "report";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractTitle(html, fallback) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return t[1].trim().replace(/\s+/g, " ");
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1[1].trim()) return h1[1].replace(/<[^>]*>/g, "").trim().replace(/\s+/g, " ");
  return fallback;
}

function shortHash(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 6);
}

function fail(msg) {
  console.error("✖ " + msg);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// Surge auth — account creation & token, entirely headless
// ---------------------------------------------------------------------------

function surgeToken(email, password) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${email}:${password}`).toString("base64");
    const req = https.request(
      SURGE_ENDPOINT + "/token",
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + auth,
          "Content-Length": 0,
          "User-Agent": "sharelinks",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(body);
          } catch {}
          // Raw endpoint returns { token }, SDK-style responses use { pass }.
          const token = parsed.token || parsed.pass;
          if (res.statusCode >= 200 && res.statusCode < 300 && token) {
            resolve(token);
          } else {
            const detail =
              parsed.messages && parsed.messages.length
                ? parsed.messages.join("; ")
                : parsed.error || body || `HTTP ${res.statusCode}`;
            reject(new Error(detail));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// setup — create/attach a Surge account and pick a domain
// ---------------------------------------------------------------------------

async function cmdSetup(flags) {
  ensureDirs();
  const cfg = loadConfig();

  const email = flags.email || cfg.email || process.env.SHARELINKS_EMAIL;
  if (!email) {
    fail(
      "No email. Run: sharelinks setup --email you@example.com\n" +
        "  (Signing in creates the Surge account automatically if it doesn't exist.)"
    );
  }

  // Reuse a stored password if present, otherwise generate a strong one.
  const password =
    flags.password || cfg.password || crypto.randomBytes(18).toString("base64url");

  process.stdout.write(`→ Authenticating ${email} with Surge (creates the account if new)… `);
  let token;
  try {
    token = await surgeToken(email, password);
  } catch (e) {
    console.log("failed.");
    fail(
      `Surge auth failed: ${e.message}\n` +
        "  If this email already has a Surge account, pass its password:\n" +
        `  sharelinks setup --email ${email} --password 'YOUR_PASSWORD'`
    );
  }
  console.log("ok.");

  const domain =
    flags.domain ||
    cfg.domain ||
    `sharelinks-${shortHash(email + Date.now())}.surge.sh`;

  saveConfig({ ...cfg, email, password, token, domain });

  console.log(`✓ Account ready.`);
  console.log(`  Domain : https://${domain}`);
  console.log(`  Config : ${CONFIG_PATH}`);
  console.log(`\nPublish your first report:  sharelinks publish ./report.html`);
  return { email, password, token, domain };
}

async function ensureReady(flags = {}) {
  const cfg = loadConfig();
  if (cfg.token && cfg.domain && cfg.email) return cfg;
  // Auto-run setup if we have an email to work with; otherwise instruct.
  if (flags.email || cfg.email || process.env.SHARELINKS_EMAIL) {
    return await cmdSetup(flags);
  }
  fail("Not set up yet. Run: sharelinks setup --email you@example.com");
}

// ---------------------------------------------------------------------------
// publish — add/update a report in the library, then deploy
// ---------------------------------------------------------------------------

async function cmdPublish(positional, flags) {
  const file = positional[0];
  if (!file) fail("Usage: sharelinks publish <file.html> [--title T] [--theme Theme]");
  if (!fs.existsSync(file)) fail(`File not found: ${file}`);

  const cfg = await ensureReady(flags);
  ensureDirs();
  const html = fs.readFileSync(file, "utf8");

  const title = (flags.title && String(flags.title)) || extractTitle(html, path.basename(file, path.extname(file)));
  const theme = (flags.theme && String(flags.theme).trim()) || "Uncategorized";

  const manifest = loadManifest();

  // Update in place if a report with the same title already exists (iterative
  // report edits keep their URL); otherwise mint a new id.
  let item = manifest.items.find((x) => x.title.toLowerCase() === title.toLowerCase());
  const now = new Date().toISOString();
  if (item) {
    item.theme = theme;
    item.updatedAt = now;
  } else {
    const id = `${slugify(title)}-${shortHash(title + now)}`;
    item = { id, title, theme, createdAt: now, updatedAt: now };
    manifest.items.push(item);
  }

  fs.writeFileSync(path.join(SOURCES_DIR, item.id + ".html"), html);
  saveManifest(manifest);

  buildSite(cfg, manifest);

  const url = `https://${cfg.domain}/r/${item.id}/`;
  item.url = url;
  saveManifest(manifest);

  if (flags["no-deploy"]) {
    console.log(`✓ Added "${title}" under “${theme}” (not deployed — --no-deploy).`);
    console.log(`  Will be live at: ${url}`);
    return;
  }

  deploy(cfg);
  console.log(`✓ Published "${title}" under “${theme}”.`);
  console.log(`  Report : ${url}`);
  console.log(`  Gallery: https://${cfg.domain}`);
}

// ---------------------------------------------------------------------------
// build — regenerate the deployable site from the manifest + sources
// ---------------------------------------------------------------------------

function buildSite(cfg, manifest) {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BUILD_DIR, "r"), { recursive: true });

  for (const item of manifest.items) {
    const src = path.join(SOURCES_DIR, item.id + ".html");
    if (!fs.existsSync(src)) continue;
    const dest = path.join(BUILD_DIR, "r", item.id);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(src, path.join(dest, "index.html"));
  }

  fs.writeFileSync(path.join(BUILD_DIR, "index.html"), renderGallery(cfg, manifest));
  fs.writeFileSync(path.join(BUILD_DIR, "CNAME"), cfg.domain + "\n");
  // 200.html makes Surge serve the gallery for unknown top-level paths.
  fs.writeFileSync(path.join(BUILD_DIR, "200.html"), renderGallery(cfg, manifest));
}

// A hand-built pixel-art Paris skyline: Haussmann rooftops + the Eiffel Tower +
// a sun (day) / moon + stars (night). Built as an inline SVG of blocky rects.
function parisSvg() {
  const W = 300; // scene width
  const G = 78; // ground line
  const cx = 150; // Eiffel centre
  const P = [];
  const px = (x, y, w, h, cls) =>
    P.push(`<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`);

  // Row of Haussmann buildings with mansard roofs and windows. Two shorter
  // ones (116, 170) peek out just beside the tower's splayed legs.
  const blds = [
    [0, 24, 30], [24, 20, 44], [44, 24, 26], [68, 20, 40], [88, 22, 20],
    [116, 16, 18], [170, 14, 22],
    [186, 24, 42], [210, 20, 28], [230, 26, 48], [256, 20, 30], [276, 24, 36],
  ];
  for (const [x, w, h] of blds) {
    const top = G - h;
    px(x, top, w, h, "wall");
    px(x + 1, top - 3, w - 2, 3, "roof"); // mansard cap
    for (let wy = top + 4; wy < G - 3; wy += 7) {
      for (let wx = x + 3; wx < x + w - 3; wx += 6) px(wx, wy, 3, 4, "win");
    }
  }

  // Eiffel Tower.
  px(cx - 1, 4, 2, 4, "iron"); // antenna
  px(cx - 1, 8, 2, 7, "iron"); // spire
  px(cx - 3, 15, 6, 2, "iron"); // top platform
  px(cx - 1, 17, 2, 6, "iron"); // neck
  px(cx - 3, 23, 6, 2, "iron"); // 2nd platform
  px(cx - 2, 25, 4, 5, "iron");
  px(cx - 3, 30, 6, 5, "iron");
  px(cx - 5, 35, 10, 3, "iron");
  px(cx - 14, 39, 28, 3, "iron"); // first platform (wide deck)
  // Splayed legs (staircase) forming the arch.
  for (let y = 42; y < G; y += 2) {
    const p = (y - 42) / (G - 42);
    const outer = Math.round(cx - 5 - p * 13);
    const inner = Math.round(cx - 2 - p * 7);
    px(outer, y, inner - outer, 2, "iron");
    px(2 * cx - inner, y, inner - outer, 2, "iron");
  }
  px(cx - 9, 56, 18, 1, "iron"); // lattice cross-bars
  px(cx - 13, 70, 26, 1, "iron");

  // Top-left celestial body, clear of the toggle. Sun (day): blocky disc + rays.
  const sx = 30, sy = 12;
  px(sx, sy, 10, 10, "sun");
  px(sx + 3, sy - 4, 4, 3, "sun"); px(sx + 3, sy + 11, 4, 3, "sun");
  px(sx - 4, sy + 3, 3, 4, "sun"); px(sx + 11, sy + 3, 3, 4, "sun");
  // Moon (night): a pixel disc minus an offset disc = crescent.
  const disc = (dcx, dcy, r, cls) => {
    for (let dy = -r; dy <= r; dy++) {
      const half = Math.round(Math.sqrt(r * r - dy * dy));
      if (half > 0) px(dcx - half, dcy + dy, half * 2, 1, cls);
    }
  };
  disc(35, 18, 6, "moon");
  disc(39, 16, 6, "moon-carve");

  // Stars (night only).
  for (const [x, y] of [[62, 14], [96, 9], [120, 20], [200, 12], [228, 8], [270, 26], [186, 16], [16, 40], [290, 18], [48, 26]])
    px(x, y, 2, 2, "star");

  px(0, G, W, 2, "ground");

  return (
    `<svg class="paris" viewBox="0 0 ${W} ${G + 2}" preserveAspectRatio="xMidYMax meet" aria-hidden="true">` +
    P.join("") +
    `</svg>`
  );
}

function renderGallery(cfg, manifest) {
  const items = [...manifest.items].sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || "")
  );

  const themes = {};
  for (const it of items) {
    (themes[it.theme] || (themes[it.theme] = [])).push(it);
  }
  const themeNames = Object.keys(themes).sort((a, b) => a.localeCompare(b));

  const count = items.length;
  const fmt = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d
      .toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })
      .toUpperCase();
  };

  const sections = themeNames
    .map((name, i) => {
      const cards = themes[name]
        .map(
          (it) => `
          <a class="card" href="./r/${it.id}/" data-title="${escapeHtml(it.title.toLowerCase())}">
            <span class="corner"></span>
            <span class="card-title">${escapeHtml(it.title)}</span>
            <span class="card-meta">${fmt(it.updatedAt || it.createdAt)}</span>
          </a>`
        )
        .join("");
      return `
        <section class="district" style="--acc:var(--a${i % 4})" data-theme="${escapeHtml(name.toLowerCase())}">
          <div class="sign">
            <div class="awning"></div>
            <div class="plaque"><span class="plaque-name">${escapeHtml(name)}</span><span class="token">${themes[name].length}</span></div>
          </div>
          <div class="grid">${cards}</div>
        </section>`;
    })
    .join("");

  const empty = `
    <div class="empty">
      <p class="empty-line">Rien à voir ici… pour l'instant.</p>
      <p class="empty-sub">Publish your first report:</p>
      <code>sharelinks publish ./report.html</code>
    </div>`;

  const title = escapeHtml(cfg.title || "My Reports");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: oklch(0.965 0.014 85); --panel: oklch(0.93 0.02 84);
    --card: oklch(0.99 0.012 85); --ink: oklch(0.30 0.035 265);
    --muted: oklch(0.50 0.03 265); --frame: oklch(0.30 0.035 265);
    --shadow: oklch(0.30 0.035 265 / 0.85);
    --a0: oklch(0.66 0.11 235); --a1: oklch(0.70 0.12 78);
    --a2: oklch(0.56 0.17 25);  --a3: oklch(0.54 0.10 155);
    --sky-top: oklch(0.90 0.05 238); --sky-bot: oklch(0.965 0.014 85);
    --wall: oklch(0.85 0.02 78); --roof: oklch(0.55 0.03 250);
    --win: oklch(0.52 0.05 255); --iron: oklch(0.42 0.03 60);
    --sun: oklch(0.78 0.13 78); --moon: oklch(0.90 0.05 90);
    --star: oklch(0.60 0.05 250);
  }
  :root[data-theme="night"] { color-scheme: dark; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="day"]) { color-scheme: dark; } }
  :root[data-theme="night"], :root:not([data-theme="day"]) {}
  /* Night palette */
  ${""}
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="day"]) {
      --bg: oklch(0.22 0.045 265); --panel: oklch(0.27 0.045 265);
      --card: oklch(0.285 0.05 265); --ink: oklch(0.93 0.02 85);
      --muted: oklch(0.72 0.03 250); --frame: oklch(0.93 0.02 85);
      --shadow: oklch(0.12 0.04 265 / 0.9);
      --a0: oklch(0.74 0.11 235); --a1: oklch(0.82 0.13 82);
      --a2: oklch(0.66 0.17 25);  --a3: oklch(0.64 0.10 155);
      --sky-top: oklch(0.16 0.05 265); --sky-bot: oklch(0.27 0.05 265);
      --wall: oklch(0.31 0.04 265); --roof: oklch(0.24 0.04 265);
      --win: oklch(0.82 0.13 82); --iron: oklch(0.55 0.04 265);
      --sun: oklch(0.78 0.13 78); --moon: oklch(0.86 0.09 88);
      --star: oklch(0.92 0.03 90);
    }
  }
  :root[data-theme="night"] {
    --bg: oklch(0.22 0.045 265); --panel: oklch(0.27 0.045 265);
    --card: oklch(0.285 0.05 265); --ink: oklch(0.93 0.02 85);
    --muted: oklch(0.72 0.03 250); --frame: oklch(0.93 0.02 85);
    --shadow: oklch(0.12 0.04 265 / 0.9);
    --a0: oklch(0.74 0.11 235); --a1: oklch(0.82 0.13 82);
    --a2: oklch(0.66 0.17 25);  --a3: oklch(0.64 0.10 155);
    --sky-top: oklch(0.16 0.05 265); --sky-bot: oklch(0.27 0.05 265);
    --wall: oklch(0.31 0.04 265); --roof: oklch(0.24 0.04 265);
    --win: oklch(0.82 0.13 82); --iron: oklch(0.55 0.04 265);
    --sun: oklch(0.78 0.13 78); --moon: oklch(0.86 0.09 88);
    --star: oklch(0.92 0.03 90);
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font-family: "Bricolage Grotesque", system-ui, sans-serif;
    background-image: radial-gradient(var(--panel) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  .pixel { font-family: "Silkscreen", ui-monospace, monospace; }

  /* Sky + skyline */
  .sky { position: relative; width: 100%; overflow: hidden;
    background: linear-gradient(var(--sky-top), var(--sky-bot));
    border-bottom: 3px solid var(--frame); }
  .paris { display: block; width: 100%; max-width: 1500px; margin: 0 auto;
    height: auto; image-rendering: pixelated; shape-rendering: crispEdges; }
  .wall { fill: var(--wall); } .roof { fill: var(--roof); } .win { fill: var(--win); }
  .iron { fill: var(--iron); } .ground { fill: var(--frame); }
  .sun { fill: var(--sun); } .moon { fill: var(--moon); } .moon-carve { fill: var(--sky-top); }
  .star { fill: var(--star); }
  .moon, .moon-carve, .star { display: none; }
  :root[data-theme="night"] .sun { display: none; }
  :root[data-theme="night"] .moon, :root[data-theme="night"] .moon-carve,
  :root[data-theme="night"] .star { display: block; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="day"]) .sun { display: none; }
    :root:not([data-theme="day"]) .moon, :root:not([data-theme="day"]) .moon-carve,
    :root:not([data-theme="day"]) .star { display: block; }
  }

  /* Day/night toggle */
  .toggle { position: absolute; top: 14px; right: 16px; z-index: 3;
    background: var(--card); color: var(--ink); border: 3px solid var(--frame);
    box-shadow: 4px 4px 0 var(--shadow); cursor: pointer; padding: 7px 9px 5px;
    line-height: 1; font-size: 15px; transition: transform .15s cubic-bezier(.16,1,.3,1), box-shadow .15s; }
  .toggle:hover { transform: translate(-1px,-2px); box-shadow: 6px 6px 0 var(--shadow); }
  .toggle:active { transform: translate(2px,2px); box-shadow: 1px 1px 0 var(--shadow); }
  .i-moon { display: none; }
  :root[data-theme="night"] .i-sun { display: none; }
  :root[data-theme="night"] .i-moon { display: inline; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="day"]) .i-sun { display: none; }
    :root:not([data-theme="day"]) .i-moon { display: inline; }
  }

  .wrap { max-width: 980px; margin: 0 auto; padding: 0 22px; }
  .masthead { padding: 26px 0 8px; }
  h1 { margin: 0; font-family: "Silkscreen", monospace; font-weight: 700;
    font-size: clamp(22px, 5.2vw, 40px); letter-spacing: 0.02em; line-height: 1.05;
    color: var(--ink); text-shadow: 3px 3px 0 var(--shadow); }
  .sub { font-family: "Silkscreen", monospace; font-size: 11px; letter-spacing: 0.04em;
    color: var(--muted); margin: 16px 0 18px; }

  .search { width: 100%; max-width: 380px; padding: 12px 14px 10px;
    background: var(--card); color: var(--ink); border: 3px solid var(--frame);
    box-shadow: 4px 4px 0 var(--shadow); font-family: "Silkscreen", monospace;
    font-size: 11px; outline: none; }
  .search::placeholder { color: var(--muted); }
  .search:focus { box-shadow: 4px 4px 0 var(--a0); border-color: var(--a0); }

  main { padding: 8px 0 72px; }

  /* District (theme) */
  .district { margin-top: 40px; }
  .sign { display: inline-block; margin-bottom: 18px; }
  .awning { height: 12px; width: 100%;
    background: repeating-linear-gradient(90deg,
      var(--acc) 0 10px, color-mix(in oklch, var(--acc) 42%, white) 10px 20px);
    border: 3px solid var(--frame); border-bottom: none; }
  .plaque { display: flex; align-items: center; gap: 12px;
    background: var(--acc); border: 3px solid var(--frame);
    box-shadow: 4px 4px 0 var(--shadow); padding: 8px 12px; }
  .plaque-name { font-family: "Silkscreen", monospace; font-weight: 700; font-size: 13px;
    letter-spacing: 0.03em; color: oklch(0.20 0.03 265); }
  .token { font-family: "Silkscreen", monospace; font-size: 11px; color: var(--ink);
    background: var(--card); border: 2px solid var(--frame); padding: 3px 7px 1px; }

  .grid { display: grid; gap: 18px;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .card { position: relative; display: flex; flex-direction: column; gap: 12px;
    min-height: 104px; padding: 16px 16px 14px; text-decoration: none;
    background: var(--card); color: var(--ink);
    border: 3px solid var(--frame); box-shadow: 5px 5px 0 var(--shadow);
    transition: transform .16s cubic-bezier(.16,1,.3,1), box-shadow .16s cubic-bezier(.16,1,.3,1); }
  .card:hover { transform: translate(-2px, -3px); box-shadow: 8px 9px 0 var(--acc); }
  .corner { position: absolute; top: 8px; right: 8px; width: 8px; height: 8px;
    background: var(--acc); box-shadow: -4px 0 0 var(--acc), 0 4px 0 var(--acc); }
  .card-title { font-weight: 700; font-size: 17px; line-height: 1.2;
    letter-spacing: -0.01em; padding-right: 14px; max-width: 34ch; }
  .card-meta { margin-top: auto; font-family: "Silkscreen", monospace; font-size: 9px;
    letter-spacing: 0.06em; color: var(--muted); }

  .empty { max-width: 460px; margin: 48px auto; text-align: center; }
  .empty-line { font-family: "Silkscreen", monospace; font-size: 15px; color: var(--ink); }
  .empty-sub { color: var(--muted); margin: 18px 0 8px; }
  .empty code, code { font-family: "Silkscreen", monospace; font-size: 11px;
    background: var(--panel); color: var(--ink); border: 2px solid var(--frame);
    padding: 6px 9px; display: inline-block; }

  footer { border-top: 3px solid var(--frame); }
  .foot { font-family: "Silkscreen", monospace; font-size: 9px; letter-spacing: 0.06em;
    color: var(--muted); padding: 18px 0 40px; }

  @media (prefers-reduced-motion: reduce) {
    .card, .toggle { transition: none; }
  }
</style>
</head>
<body>
  <div class="sky">
    <button class="toggle" id="toggle" type="button" aria-label="Toggle day and night">
      <span class="i-sun">&#9728;</span><span class="i-moon">&#9790;</span>
    </button>
    ${parisSvg()}
  </div>
  <div class="wrap">
    <header class="masthead">
      <h1>${title}</h1>
      <p class="sub">${count} rapport${count === 1 ? "" : "s"} &middot; ${themeNames.length} quartier${themeNames.length === 1 ? "" : "s"}</p>
      <input id="q" class="search" type="search" placeholder="Filtrer les rapports&hellip;" autocomplete="off" aria-label="Filter reports">
    </header>
    <main id="list">
      ${count ? sections : empty}
    </main>
  </div>
  <footer><div class="wrap"><p class="foot">FAIT AVEC SHARELINKS &middot; &Agrave; PARIS, EN PIXELS</p></div></footer>
  <script>
    (function () {
      var root = document.documentElement;
      try { var saved = localStorage.getItem('sl-theme'); if (saved) root.setAttribute('data-theme', saved); } catch (e) {}
      var btn = document.getElementById('toggle');
      btn && btn.addEventListener('click', function () {
        var cur = root.getAttribute('data-theme');
        if (!cur) {
          var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          cur = dark ? 'night' : 'day';
        }
        var next = cur === 'night' ? 'day' : 'night';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('sl-theme', next); } catch (e) {}
      });
      var q = document.getElementById('q');
      q && q.addEventListener('input', function () {
        var t = q.value.trim().toLowerCase();
        var list = document.querySelectorAll('.district');
        for (var i = 0; i < list.length; i++) {
          var sec = list[i], any = false, cards = sec.querySelectorAll('.card');
          for (var j = 0; j < cards.length; j++) {
            var hit = !t || cards[j].dataset.title.indexOf(t) > -1 || sec.dataset.theme.indexOf(t) > -1;
            cards[j].style.display = hit ? '' : 'none';
            if (hit) any = true;
          }
          sec.style.display = any ? '' : 'none';
        }
      });
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// deploy — push the built site to Surge, headless via token
// ---------------------------------------------------------------------------

function deploy(cfg) {
  if (!fs.existsSync(path.join(BUILD_DIR, "index.html"))) {
    buildSite(cfg, loadManifest());
  }
  try {
    execFileSync("npx", ["--yes", "surge", BUILD_DIR, cfg.domain], {
      stdio: "inherit",
      env: { ...process.env, SURGE_LOGIN: cfg.email, SURGE_TOKEN: cfg.token },
    });
  } catch (e) {
    fail("Deploy failed. Is npx available? Try: npm i -g surge\n  " + (e.message || ""));
  }
}

// ---------------------------------------------------------------------------
// misc commands
// ---------------------------------------------------------------------------

async function cmdDeploy() {
  const cfg = await ensureReady();
  buildSite(cfg, loadManifest());
  deploy(cfg);
  console.log(`✓ Gallery live: https://${cfg.domain}`);
}

function cmdBuild() {
  const cfg = loadConfig();
  buildSite(cfg.domain ? cfg : { ...cfg, domain: "preview.local" }, loadManifest());
  console.log(`✓ Built ${path.join(BUILD_DIR, "index.html")}`);
}

function cmdList() {
  const cfg = loadConfig();
  const manifest = loadManifest();
  if (!manifest.items.length) {
    console.log("No reports yet. Run: sharelinks publish ./report.html");
    return;
  }
  const byTheme = {};
  for (const it of manifest.items) (byTheme[it.theme] || (byTheme[it.theme] = [])).push(it);
  for (const theme of Object.keys(byTheme).sort()) {
    console.log(`\n${theme}`);
    for (const it of byTheme[theme]) {
      const url = cfg.domain ? `https://${cfg.domain}/r/${it.id}/` : `(deploy to get URL)`;
      console.log(`  • ${it.title}\n    ${url}`);
    }
  }
  if (cfg.domain) console.log(`\nGallery: https://${cfg.domain}`);
}

function cmdInfo() {
  const cfg = loadConfig();
  const manifest = loadManifest();
  if (!cfg.email) return console.log("Not set up. Run: sharelinks setup --email you@example.com");
  console.log(`Email  : ${cfg.email}`);
  console.log(`Domain : https://${cfg.domain}`);
  console.log(`Reports: ${manifest.items.length}`);
  console.log(`Config : ${CONFIG_PATH}`);
}

async function cmdRemove(positional) {
  const id = positional[0];
  if (!id) fail("Usage: sharelinks remove <id>   (see ids via: sharelinks list --ids)");
  const cfg = await ensureReady();
  const manifest = loadManifest();
  const before = manifest.items.length;
  manifest.items = manifest.items.filter((x) => x.id !== id && x.title.toLowerCase() !== id.toLowerCase());
  if (manifest.items.length === before) fail(`No report matching "${id}".`);
  try { fs.rmSync(path.join(SOURCES_DIR, id + ".html")); } catch {}
  saveManifest(manifest);
  buildSite(cfg, manifest);
  deploy(cfg);
  console.log(`✓ Removed "${id}" and redeployed.`);
}

async function cmdRenameDomain(positional) {
  let sub = positional[0];
  if (!sub) fail("Usage: sharelinks rename-domain <new-subdomain>");
  const cfg = await ensureReady();
  if (!sub.includes(".")) sub = sub + ".surge.sh";
  const old = cfg.domain;
  cfg.domain = sub;
  saveConfig(cfg);
  const manifest = loadManifest();
  for (const it of manifest.items) it.url = `https://${sub}/r/${it.id}/`;
  saveManifest(manifest);
  buildSite(cfg, manifest);
  deploy(cfg);
  console.log(`✓ Domain changed ${old} → https://${sub} and redeployed.`);
  console.log(`  (The old domain still exists; run: npx surge teardown ${old} to free it.)`);
}

function cmdHelp() {
  console.log(`sharelinks — one home for all your generated HTML reports.

Usage:
  sharelinks setup --email you@example.com     Create/attach a free Surge account (headless)
  sharelinks publish <file.html> [options]     Add/update a report, then publish live
      --title "..."     Override the title (default: from <title> tag)
      --theme "..."     Group under this theme (default: Uncategorized)
      --no-deploy       Add to the library without deploying
  sharelinks list                              List all reports with their URLs
  sharelinks deploy                            Rebuild the gallery and redeploy
  sharelinks info                              Show account + gallery info
  sharelinks remove <id|title>                 Remove a report and redeploy
  sharelinks rename-domain <subdomain>         Move the gallery to a new subdomain

Everything lives at https://<your-domain> — the gallery — with each report at
https://<your-domain>/r/<id>/. Config + library: ~/.sharelinks/`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));

  switch (cmd) {
    case "setup": return void (await cmdSetup(flags));
    case "publish": return void (await cmdPublish(positional, flags));
    case "deploy": return void (await cmdDeploy());
    case "build": return cmdBuild();
    case "list": return cmdList();
    case "info": return cmdInfo();
    case "remove": return void (await cmdRemove(positional));
    case "rename-domain": return void (await cmdRenameDomain(positional));
    case undefined:
    case "help":
    case "--help":
    case "-h": return cmdHelp();
    default:
      console.error(`Unknown command: ${cmd}\n`);
      cmdHelp();
      process.exit(1);
  }
}

main().catch((e) => fail(e.stack || e.message));
