#!/usr/bin/env node
"use strict";

/**
 * sharelinks — PostToolUse hook.
 *
 * After Claude writes/edits a file, if it looks like a *standalone HTML report*
 * (not a web-app shell, not already published), append a gentle note to the
 * tool result so Claude offers to publish it to the user's live gallery.
 *
 * It only ever SUGGESTS — publishing still requires the user's go-ahead.
 * Any error is swallowed so the hook can never disrupt a file write.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function quietExit() {
  // No stdout → original tool output is left untouched.
  process.exit(0);
}

function emit(updatedToolOutput) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput,
      },
    })
  );
  process.exit(0);
}

try {
  const input = JSON.parse(readStdin() || "{}");
  const file = input.tool_input && input.tool_input.file_path;
  if (!file || !/\.(html?|htm)$/i.test(file)) quietExit();

  // Don't nudge on our own build output / library.
  const SL_HOME = process.env.SHARELINKS_HOME || path.join(os.homedir(), ".sharelinks");
  if (path.resolve(file).startsWith(path.resolve(SL_HOME))) quietExit();

  // Get content: Write provides it inline; for Edit, read from disk.
  let html = (input.tool_input && input.tool_input.content) || "";
  if (!html) {
    try {
      html = fs.readFileSync(file, "utf8");
    } catch {
      quietExit();
    }
  }
  if (html.length < 200) quietExit();

  // Must be a full standalone document.
  const isDoc = /<html[\s>]/i.test(html) && /<\/html>/i.test(html) && /<title[\s>]/i.test(html);
  if (!isDoc) quietExit();

  // Skip obvious web-app shells (SPA entry points, framework roots).
  if (/id=["'](root|app|__next)["']|__NEXT_DATA__|data-reactroot|type=["']module["']|\/@vite\/|webpack/i.test(html)) {
    quietExit();
  }

  // Extract a title to check whether it's already in the gallery.
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? tm[1].trim().replace(/\s+/g, " ") : "";

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SL_HOME, "manifest.json"), "utf8"));
    if (title && manifest.items.some((x) => (x.title || "").toLowerCase() === title.toLowerCase())) {
      quietExit(); // already published — don't nag
    }
  } catch {
    /* no manifest yet — fine */
  }

  // Only nudge once per session per file.
  const sid = String(input.session_id || "nosession").replace(/[^a-z0-9]/gi, "");
  const markerPath = path.join(os.tmpdir(), `sharelinks-nudge-${sid}.json`);
  let nudged = [];
  try {
    nudged = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {}
  if (nudged.includes(file)) quietExit();
  nudged.push(file);
  try {
    fs.writeFileSync(markerPath, JSON.stringify(nudged));
  } catch {}

  const orig =
    typeof input.tool_output === "string"
      ? input.tool_output
      : typeof input.tool_response === "string"
      ? input.tool_response
      : `File written: ${file}`;

  const note =
    `[sharelinks] A standalone HTML report ("${title || path.basename(file)}") was just written. ` +
    `If the user may want to share or showcase it, briefly offer to publish it to their live gallery ` +
    `using the sharelinks skill (one command → a shareable URL, auto-grouped by theme). ` +
    `Do NOT publish without the user's explicit go-ahead, and don't belabor the offer.`;

  emit(`${orig}\n\n${note}`);
} catch {
  quietExit();
}
