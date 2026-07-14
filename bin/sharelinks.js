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
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  const sections = themeNames
    .map((name) => {
      const cards = themes[name]
        .map(
          (it) => `
          <a class="card" href="./r/${it.id}/" data-title="${escapeHtml(it.title.toLowerCase())}">
            <span class="card-title">${escapeHtml(it.title)}</span>
            <span class="card-meta">${fmt(it.updatedAt || it.createdAt)}</span>
          </a>`
        )
        .join("");
      return `
        <section class="theme" data-theme="${escapeHtml(name.toLowerCase())}">
          <h2>${escapeHtml(name)} <span class="chip">${themes[name].length}</span></h2>
          <div class="grid">${cards}</div>
        </section>`;
    })
    .join("");

  const empty = `<p class="empty">Nothing published yet. Run <code>sharelinks publish ./report.html</code>.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(cfg.title || "My Reports")}</title>
<style>
  :root {
    --bg: #f6f7f9; --fg: #16181d; --muted: #6b7280; --card: #ffffff;
    --line: #e6e8ec; --accent: #3b5bdb; --chip: #eef1f8;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d0f14; --fg:#e8eaed; --muted:#9aa2b1; --card:#161a22;
            --line:#252b36; --accent:#7aa2ff; --chip:#1d2330; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { padding:48px 24px 8px; max-width:960px; margin:0 auto; }
  h1 { margin:0 0 4px; font-size:28px; letter-spacing:-0.02em; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .search { width:100%; padding:11px 14px; border:1px solid var(--line);
    border-radius:10px; background:var(--card); color:var(--fg); font-size:15px; }
  main { max-width:960px; margin:0 auto; padding:8px 24px 64px; }
  .theme { margin-top:34px; }
  .theme h2 { font-size:15px; text-transform:uppercase; letter-spacing:0.06em;
    color:var(--muted); display:flex; align-items:center; gap:8px; margin:0 0 14px; }
  .chip { background:var(--chip); color:var(--muted); border-radius:999px;
    font-size:12px; padding:2px 9px; letter-spacing:0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
  .card { display:flex; flex-direction:column; gap:6px; padding:16px 18px;
    background:var(--card); border:1px solid var(--line); border-radius:12px;
    text-decoration:none; color:var(--fg); transition:border-color .12s, transform .12s; }
  .card:hover { border-color:var(--accent); transform:translateY(-2px); }
  .card-title { font-weight:600; letter-spacing:-0.01em; }
  .card-meta { color:var(--muted); font-size:13px; }
  .empty { color:var(--muted); }
  footer { max-width:960px; margin:0 auto; padding:0 24px 48px; color:var(--muted); font-size:13px; }
  code { background:var(--chip); padding:1px 6px; border-radius:6px; font-size:13px; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(cfg.title || "My Reports")}</h1>
    <p class="sub">${count} report${count === 1 ? "" : "s"} · grouped by theme</p>
    <input id="q" class="search" type="search" placeholder="Filter reports…" autocomplete="off">
  </header>
  <main id="list">
    ${count ? sections : empty}
  </main>
  <footer>Published with sharelinks → Surge.sh</footer>
  <script>
    const q = document.getElementById('q');
    q && q.addEventListener('input', () => {
      const t = q.value.trim().toLowerCase();
      document.querySelectorAll('.theme').forEach(sec => {
        let any = false;
        sec.querySelectorAll('.card').forEach(c => {
          const hit = !t || c.dataset.title.includes(t) || sec.dataset.theme.includes(t);
          c.style.display = hit ? '' : 'none';
          if (hit) any = true;
        });
        sec.style.display = any ? '' : 'none';
      });
    });
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
