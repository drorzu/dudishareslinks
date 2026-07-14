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

// AES-256-GCM with a PBKDF2-derived key. Output shape (ciphertext||tag) and
// params match the browser WebCrypto decrypt in the gallery page.
const PBKDF2_ITER = 150000;
function encryptString(password, plaintext) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    data: Buffer.concat([enc, tag]).toString("base64"),
    iterations: PBKDF2_ITER,
  };
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

  // Optional: lock the gallery behind a password (client-side encryption).
  const gp = flags["gallery-password"];
  const galleryPassword =
    gp && gp !== true ? String(gp) : cfg.galleryPassword || undefined;

  saveConfig({ ...cfg, email, password, token, domain, galleryPassword });

  console.log(`✓ Account ready.`);
  console.log(`  Domain : https://${domain}`);
  console.log(`  Config : ${CONFIG_PATH}`);
  if (galleryPassword) {
    console.log(`  Gallery: password-protected 🔒`);
  } else {
    console.log(`  Gallery: public (optional — lock it later with: sharelinks password <password>)`);
  }
  console.log(`\nPublish your first report:  sharelinks publish ./report.html`);
  return { email, password, token, domain, galleryPassword };
}

// ---------------------------------------------------------------------------
// password — optionally lock the gallery page behind a password
// ---------------------------------------------------------------------------

async function cmdPassword(positional, flags) {
  const cfg = await ensureReady();
  const arg = positional[0];

  if (flags.clear || arg === "clear" || arg === "off" || arg === "remove") {
    if (!cfg.galleryPassword) return console.log("Gallery is already public — nothing to remove.");
    delete cfg.galleryPassword;
    saveConfig(cfg);
    buildSite(cfg, loadManifest());
    deploy(cfg);
    console.log("✓ Password removed — the gallery is public again.");
    return;
  }

  const pw = arg || (typeof flags.password === "string" ? flags.password : "") || process.env.SHARELINKS_GALLERY_PASSWORD;
  if (!pw) {
    console.log(
      cfg.galleryPassword
        ? "Gallery is password-protected 🔒\n  Change:  sharelinks password <new-password>\n  Remove:  sharelinks password clear"
        : "Gallery is public.\n  Lock it:  sharelinks password <password>"
    );
    return;
  }

  cfg.galleryPassword = String(pw);
  saveConfig(cfg);
  buildSite(cfg, loadManifest());
  deploy(cfg);
  console.log("✓ Gallery locked 🔒 — visitors need the password to see your reports.");
  console.log("  Note: the report list is encrypted client-side, but individual report");
  console.log("  URLs (…/r/<id>/) stay reachable to anyone who has the exact link.");
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

// A hand-built pixel-art Paris street scene: ornate Haussmann facades (wrought-iron
// balconies, mansard roofs, dormers, chimney pots), a café awning, plane trees,
// street lamps, cascading wisteria, and the Eiffel Tower over the rooftops.
// Sun + warm haze by day; crescent moon, lit windows, glowing lamps + stars by night.
function parisSvg() {
  const W = 300; // scene width
  const G = 82; // street line
  const cx = 150; // Eiffel centre
  const P = [];
  const px = (x, y, w, h, cls) =>
    P.push(`<rect class="${cls}" x="${Math.round(x)}" y="${Math.round(y)}" width="${w}" height="${h}"/>`);

  // Distant hazy rooftops for atmospheric depth (drawn first, behind everything).
  for (const [x, w, h] of [[6, 40, 18], [58, 52, 13], [206, 54, 17], [262, 44, 20]])
    px(x, G - h, w, h, "haze");

  // A Haussmann apartment block: stone facade, ground-floor shops, cornice,
  // mansard roof with dormers + chimney pots, windows with a wrought-iron balcony.
  function building(x, w, floors, opts) {
    opts = opts || {};
    const fh = 8, bodyH = floors * fh, top = G - bodyH;
    px(x, top, w, bodyH, "stone"); // facade
    px(x, G - 7, w, 7, "stone2"); // ground floor (shops), a touch darker
    // Mansard roof: a slate trapezoid narrowing upward.
    const rH = 6;
    for (let k = 0; k < rH; k++) {
      const inset = Math.floor(k * 0.8);
      px(x + inset, top - 1 - k, w - 2 * inset, 1, "roof");
    }
    px(x - 1, top - 1, w + 2, 1, "cornice"); // cornice band under the roof
    // Dormer windows poking from the roof.
    for (const f of [0.28, 0.66]) {
      const dx = x + Math.round(w * f);
      px(dx, top - 5, 2, 3, "roof");
      px(dx, top - 4, 2, 2, "win");
    }
    // Chimney pots on the ridge.
    px(x + 2, top - rH - 3, 2, 4, "chimney");
    px(x + w - 4, top - rH - 2, 2, 3, "chimney");
    // Windows, and a wrought-iron balcony on the "noble" 2nd floor.
    const cols = [];
    for (let wx = x + 3; wx <= x + w - 5; wx += 6) cols.push(wx);
    for (let f = 0; f < floors; f++) {
      const wy = top + 2 + f * fh;
      for (const wx of cols) px(wx, wy, 3, 5, "win");
      if (f === 1) {
        px(x + 1, wy + 6, w - 2, 1, "iron"); // rail
        for (let bx = x + 1; bx < x + w - 1; bx += 2) px(bx, wy + 5, 1, 2, "iron"); // balusters
      }
    }
    if (opts.cafe) awning(x + 1, w - 2); // street-level café awning
  }

  // Red-and-white striped café awning with a little scalloped hem.
  function awning(x, w) {
    const y = G - 9;
    px(x - 1, y - 1, w + 2, 1, "iron");
    for (let i = 0; i < w; i += 3) {
      const cls = (Math.floor(i / 3) % 2) ? "awnR" : "awnW";
      px(x + i, y, 3, 3, cls);
      px(x + i, y + 3, 2, 1, cls); // scallop hint
    }
  }

  // A plane tree: trunk + a rounded foliage blob with a lit highlight.
  function tree(x) {
    px(x, G - 6, 2, 6, "trunk");
    px(x - 4, G - 12, 10, 5, "leaf");
    px(x - 3, G - 15, 8, 4, "leaf");
    px(x - 1, G - 17, 4, 3, "leaf");
    px(x + 1, G - 14, 3, 3, "leafHi");
  }

  // An ornate street lamp with a glowing head.
  function lamp(x) {
    px(x, G - 16, 1, 16, "iron");
    px(x - 1, G - 1, 3, 1, "iron");
    px(x - 1, G - 18, 3, 3, "lampGlow");
    px(x - 2, G - 12, 5, 1, "iron"); // cross arm
  }

  // A wisteria in bloom: brown trunk, violet canopy, hanging blossom strands.
  function wisteriaTree(x) {
    px(x, G - 6, 2, 6, "trunk");
    px(x - 5, G - 15, 12, 5, "wist");
    px(x - 4, G - 18, 10, 4, "wist");
    px(x - 1, G - 20, 4, 3, "wist");
    px(x + 1, G - 17, 3, 3, "wistHi");
    for (let s = -4; s <= 5; s += 2) {
      const len = 3 + ((s + 6) % 4);
      for (let k = 0; k < len; k++) px(x + s, G - 10 + k, 2, 1, k > len - 2 ? "wistHi" : "wist");
    }
  }

  // Building row: left cluster, two low blocks flanking the tower, right cluster.
  building(0, 30, 6, {});
  building(30, 26, 7, {});
  building(56, 26, 5, {});
  building(120, 16, 3, {});
  building(168, 16, 4, {});
  building(186, 28, 6, {});
  building(214, 24, 7, { cafe: true });
  building(238, 30, 5, {});
  building(268, 32, 6, {});

  // Eiffel Tower, rising over the rooftops.
  px(cx - 1, 6, 2, 4, "iron"); // antenna
  px(cx - 1, 10, 2, 7, "iron"); // spire
  px(cx - 3, 17, 6, 2, "iron"); // upper platform
  px(cx - 1, 19, 2, 6, "iron"); // neck
  px(cx - 3, 25, 6, 2, "iron"); // 2nd platform
  px(cx - 2, 27, 4, 5, "iron");
  px(cx - 3, 32, 6, 5, "iron");
  px(cx - 5, 37, 10, 3, "iron");
  px(cx - 14, 41, 28, 3, "iron"); // first platform (wide deck)
  for (let y = 44; y < G; y += 2) {
    const p = (y - 44) / (G - 44);
    const outer = Math.round(cx - 5 - p * 13);
    const inner = Math.round(cx - 2 - p * 7);
    px(outer, y, inner - outer, 2, "iron");
    px(2 * cx - inner, y, inner - outer, 2, "iron");
  }
  px(cx - 9, 58, 18, 1, "iron"); // lattice cross-bars
  px(cx - 13, 72, 26, 1, "iron");

  px(0, G, W, 2, "ground"); // street line

  // Foreground street furniture (in front of the facades).
  tree(76);
  tree(160);
  tree(258);
  lamp(110);
  lamp(200);
  wisteriaTree(92);
  wisteriaTree(232);

  // Top-left celestial body, clear of the toggle. Sun (day): blocky disc + rays.
  const sxu = 30, syu = 12;
  px(sxu, syu, 10, 10, "sun");
  px(sxu + 3, syu - 4, 4, 3, "sun"); px(sxu + 3, syu + 11, 4, 3, "sun");
  px(sxu - 4, syu + 3, 3, 4, "sun"); px(sxu + 11, syu + 3, 3, 4, "sun");
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
  for (const [x, y] of [[62, 10], [96, 6], [128, 16], [200, 9], [228, 6], [284, 22], [186, 13], [16, 38], [292, 14], [50, 24]])
    px(x, y, 2, 2, "star");

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

  const content = count ? sections : empty;
  const locked = !!cfg.galleryPassword;
  const lockData = locked ? encryptString(cfg.galleryPassword, content) : null;

  const lockUi = `
    <div class="lock">
      <p class="lock-line pixel">&#128274; Galerie privée</p>
      <form id="lockform" class="lockform">
        <input id="pw" class="search" type="password" placeholder="Mot de passe&hellip;" autocomplete="current-password" aria-label="Password">
        <button class="unlock pixel" type="submit">Entrer</button>
      </form>
      <p id="lockerr" class="lock-err" role="alert"></p>
    </div>`;

  const mainInner = locked ? lockUi : content;
  const subtitle = locked
    ? `<span class="pixel">&#128274; galerie privée</span>`
    : `${count} rapport${count === 1 ? "" : "s"} &middot; ${themeNames.length} quartier${themeNames.length === 1 ? "" : "s"}`;

  const title = escapeHtml(cfg.title || "My Reports");

  const dayVars = `
    --bg: oklch(0.955 0.02 85); --panel: oklch(0.92 0.025 82);
    --card: oklch(0.985 0.015 85); --ink: oklch(0.30 0.035 265);
    --muted: oklch(0.50 0.03 265); --frame: oklch(0.30 0.035 265);
    --shadow: oklch(0.30 0.035 265 / 0.85);
    --a0: oklch(0.62 0.11 235); --a1: oklch(0.70 0.12 78);
    --a2: oklch(0.56 0.17 25); --a3: oklch(0.54 0.10 155);
    --sky-top: oklch(0.80 0.07 235); --sky-bot: oklch(0.93 0.055 78);
    --haze: oklch(0.87 0.028 250); --stone: oklch(0.85 0.05 78);
    --stone2: oklch(0.77 0.05 70); --roof: oklch(0.47 0.025 260);
    --cornice: oklch(0.63 0.045 72); --win: oklch(0.55 0.06 250);
    --iron: oklch(0.32 0.02 60); --chimney: oklch(0.52 0.08 45);
    --leaf: oklch(0.57 0.11 145); --leafHi: oklch(0.68 0.12 140);
    --trunk: oklch(0.42 0.05 55); --awnR: oklch(0.56 0.16 25);
    --awnW: oklch(0.93 0.03 85); --wist: oklch(0.58 0.14 300);
    --wistHi: oklch(0.72 0.13 305);
    --lampGlow: oklch(0.82 0.13 82); --sun: oklch(0.80 0.13 80);
    --moon: oklch(0.90 0.05 90); --star: oklch(0.60 0.05 250);`;

  const nightVars = `
    --bg: oklch(0.20 0.045 265); --panel: oklch(0.26 0.045 265);
    --card: oklch(0.275 0.05 265); --ink: oklch(0.93 0.02 85);
    --muted: oklch(0.72 0.03 250); --frame: oklch(0.93 0.02 85);
    --shadow: oklch(0.10 0.04 265 / 0.9);
    --a0: oklch(0.74 0.11 235); --a1: oklch(0.82 0.13 82);
    --a2: oklch(0.66 0.17 25); --a3: oklch(0.64 0.10 155);
    --sky-top: oklch(0.15 0.05 265); --sky-bot: oklch(0.28 0.055 260);
    --haze: oklch(0.26 0.04 262); --stone: oklch(0.30 0.035 262);
    --stone2: oklch(0.26 0.035 262); --roof: oklch(0.19 0.03 262);
    --cornice: oklch(0.35 0.035 262); --win: oklch(0.82 0.13 82);
    --iron: oklch(0.46 0.03 262); --chimney: oklch(0.32 0.05 40);
    --leaf: oklch(0.34 0.06 150); --leafHi: oklch(0.42 0.07 145);
    --trunk: oklch(0.28 0.03 50); --awnR: oklch(0.55 0.15 25);
    --awnW: oklch(0.80 0.04 85); --wist: oklch(0.54 0.13 300);
    --wistHi: oklch(0.66 0.13 305);
    --lampGlow: oklch(0.86 0.15 84); --sun: oklch(0.80 0.13 80);
    --moon: oklch(0.88 0.08 88); --star: oklch(0.92 0.03 90);`;

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
  :root { ${dayVars} }
  :root[data-theme="night"] { color-scheme: dark; ${nightVars} }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="day"]) { color-scheme: dark; ${nightVars} }
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
  .haze { fill: var(--haze); } .stone { fill: var(--stone); } .stone2 { fill: var(--stone2); }
  .roof { fill: var(--roof); } .cornice { fill: var(--cornice); } .win { fill: var(--win); }
  .iron { fill: var(--iron); } .chimney { fill: var(--chimney); }
  .leaf { fill: var(--leaf); } .leafHi { fill: var(--leafHi); } .trunk { fill: var(--trunk); }
  .awnR { fill: var(--awnR); } .awnW { fill: var(--awnW); } .wist { fill: var(--wist); }
  .wistHi { fill: var(--wistHi); }
  .lampGlow { fill: var(--lampGlow); } .ground { fill: var(--frame); }
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

  /* Password lock */
  .lock { max-width: 420px; margin: 40px 0 60px; }
  .lock-line { font-size: 14px; color: var(--ink); margin: 0; }
  .lockform { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
  .lock .search { max-width: 240px; }
  .unlock { background: var(--a0); color: oklch(0.20 0.03 265);
    border: 3px solid var(--frame); box-shadow: 4px 4px 0 var(--shadow); cursor: pointer;
    padding: 12px 16px 10px; font-size: 11px;
    transition: transform .15s cubic-bezier(.16,1,.3,1), box-shadow .15s; }
  .unlock:hover { transform: translate(-1px,-2px); box-shadow: 6px 6px 0 var(--shadow); }
  .unlock:active { transform: translate(2px,2px); box-shadow: 1px 1px 0 var(--shadow); }
  .lock-err { font-family: "Silkscreen", monospace; font-size: 10px; color: var(--a2);
    margin: 12px 0 0; min-height: 12px; letter-spacing: 0.04em; }

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
      <p class="sub">${subtitle}</p>
      <input id="q" class="search" type="search" placeholder="Filtrer les rapports&hellip;" autocomplete="off" aria-label="Filter reports"${locked ? ' style="display:none"' : ""}>
    </header>
    <main id="list">
      ${mainInner}
    </main>
  </div>
  <footer><div class="wrap"><p class="foot">FAIT AVEC SHARELINKS &middot; &Agrave; PARIS, EN PIXELS</p></div></footer>
  <script id="lockdata" type="application/json">${lockData ? JSON.stringify(lockData) : "null"}</script>
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
      function initFilter() {
        if (!q) return;
        q.addEventListener('input', function () {
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
      }

      var LOCK = JSON.parse(document.getElementById('lockdata').textContent || 'null');
      if (!LOCK) { initFilter(); return; }

      var list = document.getElementById('list');
      function b64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
      async function decryptGallery(pw) {
        var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
        var key = await crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: b64(LOCK.salt), iterations: LOCK.iterations, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        var buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(LOCK.iv) }, key, b64(LOCK.data));
        return new TextDecoder().decode(buf);
      }
      var err = document.getElementById('lockerr');
      async function attempt(pw, remember) {
        try {
          var html = await decryptGallery(pw);
          list.innerHTML = html;
          if (q) q.style.display = '';
          initFilter();
          if (remember) { try { sessionStorage.setItem('sl-pw', pw); } catch (e) {} }
        } catch (e) {
          if (err) err.textContent = 'Mauvais mot de passe.';
          try { sessionStorage.removeItem('sl-pw'); } catch (e2) {}
        }
      }
      var form = document.getElementById('lockform');
      form && form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (err) err.textContent = '';
        attempt(document.getElementById('pw').value, true);
      });
      if (!(window.crypto && crypto.subtle)) {
        if (err) err.textContent = 'Needs HTTPS to unlock.';
        return;
      }
      var savedPw = null; try { savedPw = sessionStorage.getItem('sl-pw'); } catch (e) {}
      if (savedPw) attempt(savedPw, false);
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
      --gallery-password "..."   (optional) lock the gallery behind a password
  sharelinks publish <file.html> [options]     Add/update a report, then publish live
      --title "..."     Override the title (default: from <title> tag)
      --theme "..."     Group under this theme (default: Uncategorized)
      --no-deploy       Add to the library without deploying
  sharelinks list                              List all reports with their URLs
  sharelinks deploy                            Rebuild the gallery and redeploy
  sharelinks password <password>               Lock the gallery (encrypted); "clear" to unlock
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
    case "password":
    case "lock": return void (await cmdPassword(positional, flags));
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
