# WPIAL All Stars — site & backend

Public keeper-league site for the WPIAL All Stars fantasy football league. Live at **https://wadi.solutions**.

This README is written for a non-developer owner. If something breaks, start here before panicking.

---

## 1. What this actually is (tech stack)

Nothing here costs money and nothing runs on a server you have to maintain. It's four free services glued together:

| Piece | What it does | Where it lives |
|---|---|---|
| **GitHub** | Stores the website's code and publishes it | [github.com/bryanweimerskirch-ux/wpial-allstars](https://github.com/bryanweimerskirch-ux/wpial-allstars) |
| **GitHub Pages + Actions** | Turns the code in the repo into the live website automatically, every time you save a change | Settings → Pages in the repo |
| **Squarespace (DNS only)** | Points the domain `wadi.solutions` at GitHub instead of a Squarespace site. You are **not** paying for or using Squarespace's website builder — just their domain registrar/DNS panel. | Squarespace → Domains → DNS Settings |
| **Google Apps Script + Google Sheets** | The "backend." Serves approved Feed posts to the site, and collects League Tips submissions into a spreadsheet tab | Bound to the "FF2025-2026 Keeper List - Google Sheets" file |
| **Cloudflare Web Analytics** | Free, privacy-friendly page-view tracking | [dash.cloudflare.com](https://dash.cloudflare.com) |

There is no database, no hosting bill, and no server to patch. The "backend" is a spreadsheet with a small script attached to it.

---

## 2. The GitHub repo, explained

Repo: `bryanweimerskirch-ux/wpial-allstars`

```
wpial-allstars/
├── index.html              ← the entire website (HTML + CSS + JS in one file)
├── CNAME                   ← tells GitHub Pages the custom domain is wadi.solutions
└── .github/workflows/
    └── static.yml           ← the robot that publishes index.html to the live site
```

**index.html** is the whole site — rosters, league history, and The Feed tab, plus all the styling and JavaScript. There's no build step, no npm, no compiling. What's in that file is exactly what's live.

**How a change goes live:**
1. Edit `index.html` (either locally and re-upload, or directly in GitHub's web editor — click the file, then the pencil icon).
2. Commit the change (GitHub's UI will prompt you for a commit message and a "Commit changes" button).
3. That commit automatically triggers the **Deploy static content to Pages** workflow under the **Actions** tab.
4. Wait ~20–30 seconds, refresh Actions, confirm it shows a green checkmark.
5. The live site updates within a minute or two (sometimes a few minutes longer if Cloudflare/browser caching is stubborn — a hard refresh or private window clears that up).

**Where to check deploy status:** repo → **Actions** tab → most recent run. Green check = live. Red X = something broke (click into it, the error log tells you which line of HTML choked).

**Custom domain / HTTPS:** repo → **Settings → Pages**. This is where `wadi.solutions` is registered as the custom domain and where "Enforce HTTPS" lives. You should never need to touch this again unless the domain itself changes.

---

## 3. The backend (Google Apps Script)

### Why it exists
Two things on the site need to be shared across every visitor, not just saved in one person's browser: the Feed content, and League Tips submissions. Google Sheets + Apps Script is the free, no-server way to do that.

### The pieces
- **Google Sheet:** "FF2025-2026 Keeper List - Google Sheets" — the *native* Google Sheets copy (not the old `.xlsx` one; Apps Script doesn't work on `.xlsx`-format files).
  - Tab **"Feed Posts"** — anything in this tab (columns: timestamp, author, text, comments, retweets, likes, views) is treated as approved and shows up live at the top of The Feed under "📡 Live from the league."
  - Tab **"Tips"** — every League Tips submission lands here automatically with status `pending`. This is the commissioner's inbox to review.
  - **Nothing else in this Sheet is touched.** The script can't see or modify your roster/keeper/draft tabs, and your Sheet's Drive sharing settings are completely separate from this — the site never gets access to your Drive.
- **Apps Script project:** "WPIAL Feed API," bound to that Sheet. Open it via the Sheet's **Extensions → Apps Script** menu, or directly: `https://script.google.com/u/0/home/projects/1jvQ_A8xvxZy3Qp8yfJh4P9fs37TTMteCyltshX3WBEyiwnNkb6xTiE9_/edit`
- **Deployed Web App URL** (what the site actually calls):
  `https://script.google.com/macros/s/AKfycbzLkIIGEBrgAmBKAxmVKERqcRCGhRySybSg9Ne0zCnIUf7yIoP6G7h1sZI7b7INV6ywUA/exec`
  This exact URL is hardcoded in `index.html` as the `WEB_APP_URL` constant near the bottom of the `<script>` tag.

### The day-to-day workflow
1. A league member submits a tip through the site → it appears as a new row in the **Tips** tab, status `pending`.
2. You (commissioner) read it, decide if/how to use it.
3. If you want it to become a real "Gelly" post, add a row to the **Feed Posts** tab with the text you want — it appears live on the site automatically, no redeploy needed.
4. Optionally mark the Tips row's status column `used` or `rejected` so you know you've handled it — the site doesn't read that status, it's just for your own bookkeeping.

### If you ever need to change the backend code
Open the Apps Script project → `Code.gs` → edit → **Ctrl+S** to save → **Deploy → Manage deployments → pencil/edit icon → Deploy** to push the change live under the *same* URL. (Creating a brand-new deployment instead of editing the existing one would generate a new URL, which would break the site until you updated `WEB_APP_URL` in `index.html` to match — so always edit the existing deployment.)

---

## 4. "Something's broken" — quick triage

**Site is down / showing an old version:**
1. Check `https://wadi.solutions` directly in an incognito/private window (rules out your own browser cache).
2. Check the **Actions** tab in GitHub — is the latest run green?
3. If red, click into it and read the error — it's almost always a typo/unclosed tag in `index.html`.
4. To roll back instantly: repo → **Commits** (clock icon near the file list) → find the last known-good commit → **⋯ → Browse repository at this point** → grab that file's contents → re-save as the current `index.html`. Or simpler: click the bad commit, click **Revert**.

**Certificate / "connection not private" warning:**
This means GitHub hasn't finished issuing the HTTPS certificate for the domain — it's not a hack, and it resolves on its own (GitHub says up to 24 hours after a DNS change). Check status at **Settings → Pages** — if it says "Certificate Requested" or similar, just wait. Once it's issued, confirm **Enforce HTTPS** is checked so this can't happen again.

**Feed / League Tips not working (button does nothing, feed never loads):**
1. Confirm the Apps Script is still deployed: open the Apps Script project → **Deploy → Manage deployments** → should show an active Web App deployment.
2. Confirm `WEB_APP_URL` in `index.html` matches the URL shown there exactly.
3. Open the deployed URL directly in a browser with `?action=feed` on the end — you should see raw JSON like `{"posts":[...]}`. If you get an error page instead, the deployment itself is broken and needs to be redeployed (see section 3).

**You changed something in the Google Sheet and the site didn't update:**
The Feed pulls live on every page load — there's no caching on that end. If it's not showing, double check you added the row to the **Feed Posts** tab specifically (not Tips, not any other tab), and that the columns are in the right order (timestamp, author, text, comments, retweets, likes, views).

**You want to take the whole site down temporarily:**
repo → **Settings → Pages → Unpublish site**. This takes it offline instantly without deleting any code — flip it back on the same way.

---

## 5. Useful links

- Live site: https://wadi.solutions
- GitHub repo: https://github.com/bryanweimerskirch-ux/wpial-allstars
- GitHub Actions (deploy history): https://github.com/bryanweimerskirch-ux/wpial-allstars/actions
- GitHub Pages settings: https://github.com/bryanweimerskirch-ux/wpial-allstars/settings/pages
- Apps Script project: https://script.google.com/u/0/home/projects/1jvQ_A8xvxZy3Qp8yfJh4P9fs37TTMteCyltshX3WBEyiwnNkb6xTiE9_/edit
- Cloudflare Analytics dashboard: https://dash.cloudflare.com/6d4ca669573027c25dda30202affb06d/web-analytics/sites
- Domain DNS (Squarespace): Squarespace account → Domains → wadi.solutions → DNS Settings
