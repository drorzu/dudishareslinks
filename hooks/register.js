#!/usr/bin/env node
"use strict";

/**
 * Safely add (or remove) the sharelinks PostToolUse "suggest publish" hook in a
 * Claude Code settings.json, without clobbering existing settings/hooks.
 *
 * Usage:
 *   node register.js <settings.json> <hook-command>   # add
 *   node register.js --remove <settings.json>         # remove
 */

const fs = require("fs");
const path = require("path");

const MARK = "sharelinks-suggest-publish";
const MATCHER = "Write|Edit";

function load(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function save(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

const args = process.argv.slice(2);
const remove = args[0] === "--remove";

if (remove) {
  const settingsPath = args[1];
  if (!settingsPath) { console.error("register: --remove needs <settings.json>"); process.exit(1); }
  const s = load(settingsPath);
  const list = (s.hooks && s.hooks.PostToolUse) || [];
  const filtered = list
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((h) => !String(h.command || "").includes(MARK)),
    }))
    .filter((entry) => (entry.hooks || []).length > 0);
  if (s.hooks) s.hooks.PostToolUse = filtered;
  save(settingsPath, s);
  console.log("✓ sharelinks suggest-publish hook removed from " + settingsPath);
  process.exit(0);
}

const settingsPath = args[0];
const command = args[1];
if (!settingsPath || !command) {
  console.error('register: usage: node register.js <settings.json> <hook-command>');
  process.exit(1);
}

const s = load(settingsPath);
s.hooks = s.hooks || {};
s.hooks.PostToolUse = s.hooks.PostToolUse || [];

const already = s.hooks.PostToolUse.some((entry) =>
  (entry.hooks || []).some((h) => String(h.command || "").includes(MARK))
);
if (already) {
  console.log("✓ sharelinks suggest-publish hook already present — no change.");
  process.exit(0);
}

s.hooks.PostToolUse.push({
  matcher: MATCHER,
  hooks: [{ type: "command", command }],
});
save(settingsPath, s);
console.log("✓ sharelinks suggest-publish hook added to " + settingsPath);
