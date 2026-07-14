# sharelinks

**One home for every HTML file you generate.** Reports, dashboards, quick-link
pages, showcases — publish them and they all appear in a single live gallery,
auto-grouped by theme, each with its own shareable URL.

Built for agents: an AI (like Claude Code) can create the hosting account, publish
files, and maintain the gallery **entirely from the CLI** — no browser, no signup
page, no dashboard. Hosting is free via [Surge.sh](https://surge.sh).

## Install

One line:

```bash
git clone https://github.com/drorzu/dudishareslinks && bash dudishareslinks/install.sh
```

Or, if you already have the repo:

```bash
bash install.sh
```

That installs the `sharelinks` CLI globally and drops the Claude Code skill into
`~/.claude/skills/`. Requires Node ≥16.

## Use it in Claude Code

Just say it in plain English:

> **publish this report with sharelinks**

Claude reads the file, infers a theme, publishes it, and hands you the link.
The first publish creates your free Surge account from your email — no browser.

## Use it directly (CLI)

```bash
sharelinks setup --email you@example.com     # one-time, headless account creation
sharelinks publish ./report.html --theme "Weekly Metrics"
sharelinks list                              # every report + URL, grouped by theme
sharelinks deploy                            # rebuild + redeploy the gallery
sharelinks rename-domain my-reports          # pick a nicer subdomain
```

- **Gallery:** `https://<your-domain>`
- **Each report:** `https://<your-domain>/r/<id>/`
- **Local library + config:** `~/.sharelinks/`

Re-publishing a file with the same title updates it in place and keeps its URL.

## How the pieces fit

- **CLI (`bin/sharelinks.js`)** — zero-dependency Node. Manages the library,
  generates the gallery, authenticates with Surge headlessly, and deploys via
  `npx surge`.
- **Skill (`.claude/skills/sharelinks/`)** — the AI layer: Claude reads each file
  and picks the theme/title before calling the CLI.

## Hosting notes

Surge account creation and auth happen over its token API entirely from the
terminal. The token is stored (mode `600`) in `~/.sharelinks/config.json`.
Custom domains are free on Surge if you ever want one.
