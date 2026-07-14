---
description: Publish an HTML report to your live sharelinks gallery, or view everything you've published
argument-hint: [file.html] | list | setup | rename <subdomain>
allowed-tools: Bash(sharelinks:*), Read
---

The user invoked `/sharelinks` with arguments: `$ARGUMENTS`

Handle it with the `sharelinks` CLI, following the sharelinks skill's guidance:

- **No arguments** → run `sharelinks list` and show the gallery URL (`sharelinks info`). If it says "Not set up", run `sharelinks setup --email <the user's email>` first.
- **An `.html` / `.htm` file** (optionally prefixed with `publish`) → **Read the file**, infer a concise Title-Case **theme** (first run `sharelinks list` and reuse an existing theme when one fits, so related reports group together) and a clear **title**, then:
  `sharelinks publish <file> --title "<Title>" --theme "<Theme>"`
  Report the **Report** URL and the **Gallery** URL.
- **`setup`** → `sharelinks setup --email <the user's email>`
- **`rename <name>`** → `sharelinks rename-domain <name>`
- **`password ...`** → lock/unlock the gallery: `sharelinks password "<pw>"` (or `sharelinks password clear`). Mention it only encrypts the list; direct report URLs stay reachable.
- **Anything else** → pass through: `sharelinks $ARGUMENTS`

Keep the reply tight: confirm what happened and give the link(s). Never publish a file without the user clearly wanting it shared.
