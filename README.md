# WPIAL All Stars — site & backend

Public keeper-league site for the WPIAL All Stars fantasy football league. Live at **https://wadi.solutions**.

This README is written for a non-developer owner. If something breaks, start here before panicking.

*Last verified against the live site and the Apps Script project on 2026-08-16. Before this it had drifted for weeks — the sheet name, the deployment URL and the whole repo structure were wrong. If you change how something works, change this file in the same commit.*

---

## 1. What this actually is (tech stack)

Nothing here costs money and nothing runs on a server you have to maintain. It's five free services glued together:

| Piece | What it does | Where it lives |
|---|---|---|
| **GitHub** | Stores the website's code and publishes it | [github.com/bryanweimerskirch-ux/wpial-allstars](https://github.com/bryanweimerskirch-ux/wpial-allstars) |
| **GitHub Pages + Actions** | Turns the code in the repo into the live website automatically, every time you save a change | Settings → Pages in the repo |
| **Squarespace (DNS only)** | Points the domain `wadi.solutions` at GitHub instead of a Squarespace site. You are **not** paying for or using Squarespace's website builder — just their domain registrar/DNS panel. | Squarespace → Domains → DNS Settings |
| **Google Apps Script + Google Sheets** | The "backend" — every piece of live data the site shows | Bound to the **Wadi.Solutions** Google Sheet |
| **Cloudflare Web Analytics** | Free, privacy-friendly page-view tracking | [dash.cloudflare.com](https://dash.cloudflare.com) |
| **Firebase Realtime Database** (Spark/free plan) | The realtime draft only: shared picks, clock, presence on draft night. Owners sign in with an email link. | [console.firebase.google.com](https://console.firebase.google.com) → project `wpial-allstars` — see **DRAFTNIGHT-SETUP.md** |

There is no hosting bill and no server to patch. Both paid paths are confirmed closed: Firebase is on the free Spark plan (it cuts you off rather than billing), and the Gemini API key has **no billing account** attached. Don't click "Set up billing" on either.

---

## 2. The GitHub repo, explained

Repo: `bryanweimerskirch-ux/wpial-allstars`

It is **not** one file. It's roughly fifty, split into three groups:

```
wpial-allstars/
├── index.html            ← League News — the newspaper. This is the front page.
├── board.html            ← the tabbed shell: Rosters, Schedule, Scoreboard,
│                            Standings, Rules, League History, Gelly Feed
├── draftboard.html       ← the keeper draft board
├── roster.html           ← Depth Chart      matchup.html ← head-to-head box score
├── profile.html          ← owner profile    dashboard.html ← commissioner tools
├── press.html            ← redirect stub, kept because the URL was shared once
│
├── *.js                  ← the browser code (press.js, sitenav.js, franchise.js,
│                            draftsync.js, matchrow.js, keepers.js, auth.js, …)
├── *.gs                  ← the BACKEND source, mirrored from Apps Script
│                            (Code.gs, gelly-edition.gs, transactions.gs, matchup.gs, …)
├── theme.css             ← every colour token on the site. Pages don't define their own.
├── CNAME                 ← tells GitHub Pages the custom domain is wadi.solutions
└── verify-*.js           ← test suites you can run locally; not served to anyone
```

**Two things about the `.gs` files.** They are the backend, and GitHub is a *mirror* of them — the code that actually runs lives in the Apps Script editor (section 3). Editing a `.gs` file here does **not** change the backend. As of 2026-08-16 all thirteen are in the repo; before that, several existed only in the editor, which is how one file was permanently lost earlier in the project.

**How a change to the SITE goes live:**

1. Edit the file (in GitHub's web editor — click the file, then the pencil — or upload a new copy via **Add file → Upload files**, which takes several files in one commit).
2. Commit it.
3. That triggers the **pages-build-deployment** workflow under the **Actions** tab.
4. ~45 seconds later it shows a green check.
5. The live site updates within a minute or two. If you still see the old version, hard-refresh (**Ctrl+Shift+R**) — a plain refresh will re-use cached `.js` files even when the HTML is new.

**Working with a copy of the repo:** `git clone https://github.com/bryanweimerskirch-ux/wpial-allstars.git` works fine for reading. Pushing back does not work from every environment — if `git push` is refused, use the web editor or the upload form instead. Nothing is lost either way; the upload form produces an ordinary commit.

**Custom domain / HTTPS:** repo → **Settings → Pages**. You should never need to touch this again unless the domain changes.

---

## 3. The backend (Google Apps Script)

### Why it exists

Everything the site shows that changes — rosters, standings, keeper declarations, the Feed, the newspaper, the waiver wire — has to be the same for every visitor, not saved in one person's browser. Google Sheets + Apps Script is the free, no-server way to do that.

### The pieces

- **Google Sheet: "Wadi.Solutions"** — the *native* Google Sheets copy (not the old `.xlsx` one; Apps Script doesn't work on `.xlsx`-format files). Its tabs include:
  - **Feed Posts** — anything here is treated as approved and shows in the League Feed. Columns: `timestamp, author, text, comments, retweets, likes, views, source_text`.
  - **Tips** — League Tips submissions land here with status `pending`. Your inbox to review.
  - **InsiderReports** — the newspaper's editions (front-page lead + column).
  - **KeeperPicks / Keepers** — keeper declarations. These drive the gold stars and the "N of 10 declared" counts.
  - **Owners / Profiles / Interest / Watchlist / H2HLog / NameHistory** — accounts, franchise identity, player-interest clicks, the head-to-head log.

  *(An older version of this file claimed the script only touches Feed Posts and Tips. That has not been true for a long time.)*

- **Apps Script project: "WPIAL Feed API"**, bound to that Sheet. Open it via **Extensions → Apps Script** from the Sheet, or directly:
  `https://script.google.com/u/0/home/projects/1jvQ_A8xvxZy3Qp8yfJh4P9fs37TTMteCyltshX3WBEyiwnNkb6xTiE9_/edit`

- **Deployed Web App URL** — what the site actually calls:
  `https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec`
  It appears in `press.js`, `board.html`, `franchise.js`, `trade-machine.js` and `draftkeep.js`. If it ever changes, it changes in all of them.

### Secrets

Credentials live in **Project Settings → Script properties**, never in code. `AUTH_SECRET` (the key every owner's password is hashed with — **deleting it locks all ten owners out**), `GEMINI_API_KEY`, `ESPN_S2` / `ESPN_SWID` (ESPN session cookies; without them team-name sync and roster pulls stop), and `INSIDER_SECRET`.

**Never paste a secret into a `.gs` file.** This repo is public. A helper that hardcoded `INSIDER_SECRET` published it for twelve days before it was caught on 2026-08-16.

### Scheduled jobs

Apps Script → **Triggers** (the alarm-clock icon). There should be exactly four:

| Function | When | What it does |
|---|---|---|
| `runGellyEdition` | Sunday 9am | Writes the newspaper edition + a Feed promo |
| `runGellyEdition` | Wednesday 9am | Same |
| `syncEspnNamesHourly` | hourly | Keeps team names in step with the ESPN app |
| `onEdit` | on sheet edit | Moves an approved Tips row into the Feed |

To see what an edition *would* say without publishing it, run **`previewGellyEdition`** from the editor's function dropdown. It writes nothing — no sheet row, no Feed post. Run it after any prompt change.

### If you ever need to change the backend code

Open the Apps Script project → edit → **Ctrl+S** to save.

Saving is enough for the scheduled jobs — they run the latest saved code. **The website's data does not update until you deploy**: **Deploy → Manage deployments → pencil → Deploy**, editing the *existing* deployment. Creating a new one mints a new URL and breaks the site until every file above is updated to match. The version dropdown has selected a *rollback* on one attempt — read it back before clicking Deploy.

Then mirror the change into the `.gs` file in this repo so the two don't drift.

---

## 4. "Something's broken" — quick triage

**Site is down or showing an old version**

1. Check `https://wadi.solutions` in a private window (rules out your own cache).
2. Actions tab — is the latest run green?
3. Still stale? **Ctrl+Shift+R**. HTML can be fresh while a `.js` file is still cached.
4. Roll back: click the bad commit → **Revert**.

**A page loads but is blank or half-empty (skeleton bars that never fill)**

That's a JavaScript error, not a deploy problem. Right-click → **Inspect** → **Console** tab, and read the first red line — it names the file and line. The usual cause is markup being removed while a script still refers to it.

**Certificate / "connection not private"**

GitHub hasn't finished issuing the HTTPS certificate. Not a hack; resolves itself. Settings → Pages will say "Certificate Requested." Once issued, confirm **Enforce HTTPS**.

**Feed, standings or rosters not loading**

1. Apps Script → **Deploy → Manage deployments** → there should be an active Web App deployment.
2. Open the deployed URL with `?action=feed` on the end — you should get raw JSON like `{"posts":[...]}`.
3. If that errors, the deployment is broken — redeploy per section 3.

**You changed the Sheet and the site didn't update**

The Feed reads live on every page load. Check you edited the right tab and that the columns are in the right order. Note that removing a Feed post *blanks* the row rather than deleting it — blank rows in that tab are normal and are skipped.

**The newspaper printed something wrong or unkind**

Run `previewGellyEdition` to see what it's generating. If the copy itself is the problem, the prompt and its guards are in `gelly-edition.gs`. To stop it entirely, delete the two `runGellyEdition` triggers — that halts publishing without touching any code.

**Take the whole site down**

repo → **Settings → Pages → Unpublish site**. Reversible, deletes nothing.

---

## 5. Useful links

- Live site: https://wadi.solutions
- GitHub repo: https://github.com/bryanweimerskirch-ux/wpial-allstars
- Actions (deploy history): https://github.com/bryanweimerskirch-ux/wpial-allstars/actions
- Pages settings: https://github.com/bryanweimerskirch-ux/wpial-allstars/settings/pages
- Apps Script project: https://script.google.com/u/0/home/projects/1jvQ_A8xvxZy3Qp8yfJh4P9fs37TTMteCyltshX3WBEyiwnNkb6xTiE9_/edit
- Apps Script triggers: same URL with `/triggers` instead of `/edit`
- Cloudflare Analytics: https://dash.cloudflare.com/6d4ca669573027c25dda30202affb06d/web-analytics/sites
- Domain DNS (Squarespace): Squarespace account → Domains → wadi.solutions → DNS Settings
- Draft night setup + runbook: `DRAFTNIGHT-SETUP.md`
