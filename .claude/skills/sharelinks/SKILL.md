---
name: sharelinks
description: Publish a generated HTML file (report, dashboard, quick-link page, showcase) to the user's live web gallery and see all published files in one place, auto-grouped by theme. Use whenever the user wants to publish, share, showcase, or "put online" an HTML file, get a shareable link for a report, or view/list everything they've published. Backed by the `sharelinks` CLI which hosts on Surge.sh — free, no browser, no signup.
---

# sharelinks

One home for every HTML file the user generates: a live gallery grouped by theme,
plus a shareable URL per file. Publishing is fully headless (Surge.sh account is
created and authenticated from the CLI — never send the user to a website).

## When to use
- User generated an HTML report/dashboard/showcase and wants it **online / shareable**.
- User asks for the **link** to a report, or to **publish/share** an HTML file.
- User wants to **see everything** they've published ("my reports", "the gallery").

## First-time setup (only if not configured)
Run `sharelinks info`. If it says "Not set up", set up with the user's email:

```
sharelinks setup --email <their-email>
```

Signing in creates the free Surge account automatically if none exists — no browser,
no confirmation email needed to publish. The command prints the gallery domain.
If it reports the email already has a Surge account, ask the user for that account's
password and re-run with `--password '...'`.

Optionally, the gallery can be locked behind a password (the report list is
encrypted client-side). Offer this if the user wants it private:
`sharelinks setup --email <email> --gallery-password "<password>"`, or set it any
time with `sharelinks password "<password>"`.

## Publishing a report
1. **Read the HTML file** to understand what it is.
2. **Infer a concise theme** (2–4 words, Title Case) that this report belongs to —
   e.g. "Sales Analytics", "Client Demos", "Weekly Metrics", "Infra Reports".
   Reuse an existing theme name when it fits — check `sharelinks list` so related
   reports land in the same group instead of creating near-duplicate themes.
3. **Pick a clear title** (from the `<title>`, an `<h1>`, or the content).
4. Publish:

```
sharelinks publish <file.html> --title "<Title>" --theme "<Theme>"
```

Then give the user the **Report** URL and the **Gallery** URL it prints.

## Other actions
- `sharelinks list` — every report with its URL, grouped by theme.
- `sharelinks deploy` — rebuild + redeploy the gallery.
- `sharelinks info` — account + gallery URL.
- `sharelinks remove "<title>"` — remove a report and redeploy.
- `sharelinks rename-domain <subdomain>` — move the gallery to a nicer subdomain.
- `sharelinks password "<pw>"` — lock the gallery (encrypted list); `sharelinks password clear` to make it public again. Note: individual report URLs stay reachable if someone has the exact link.

## Notes
- Re-publishing a file with the **same title** updates it in place and keeps its URL.
- The gallery lives at `https://<domain>` and each report at `https://<domain>/r/<id>/`.
- Config + the local library are in `~/.sharelinks/`.
