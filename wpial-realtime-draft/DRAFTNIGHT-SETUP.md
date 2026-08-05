# Draft night — Firebase realtime draft setup & runbook

The LIVE draft board is now shared. Every owner drafting from their own phone or PC sees the same board, the same clock, and the same picks, live. The database is Firebase Realtime Database on the **Spark (free) plan** — no billing account attached, and draft-night usage is a rounding error against the free limits (100 simultaneous connections; we need 10).

What enforces correctness is the **server**, not the UI:

- A pick is one atomic write of `picks/<overall>` + `cursor`. A slot is write-once. Two people tapping at the same moment: one lands, the other gets a clean "he got there first" message. Nothing breaks, nothing is lost.
- Turn order is enforced by security rules against the 160-slot map written at setup. Hiding the draft button proves nothing; the rules are what stop an out-of-turn pick.
- The clock stores an absolute deadline; every device corrects its own clock skew and counts down to the same millisecond.
- You (commissioner) can pick **for** an owner whose phone died, and undo the last pick. Nobody — including you — can overwrite a filled slot.

Everything below is one-time console setup, then a rehearsal, then draft night.

---

## 1. One-time Firebase console setup (~10 minutes)

Console: https://console.firebase.google.com → project **wpial-allstars**

### a. Turn on email-link sign-in
Authentication → Sign-in method → **Email/Password** → enable, and inside it also enable **"Email link (passwordless sign-in)"** → Save.

Then Authentication → Settings → **Authorized domains** → make sure `wadi.solutions` is in the list (add it if not).

### b. Paste the database rules
Realtime Database → **Rules** tab → replace everything with the contents of **`database.rules.deploy.json`** → Publish.

⚠️ Use `database.rules.deploy.json`, NOT the annotated `database.rules.json` — the console rejects the annotated one (its `_note` keys aren't valid rule syntax). The deploy file is the same rules minus comments, plus one fix: it lets the commissioner **delete** a pick, which is what makes undo possible. These exact rules passed a 28-test suite (races, forged identity, out-of-turn picks, the full 160-slot sweep).

### c. Get your own account into the system
1. Open `https://wadi.solutions/draftboard.html?env=staging` → LIVE tab → tap **Connect** in the new strip under the header → it emails you a sign-in link → open it **on the same device**.
2. Console → Authentication → **Users** → your row appears → copy the **User UID**.

### d. Seed the two identity maps (Data tab)
Realtime Database → **Data** tab → build these at the root:

**`/commish`** — who is commissioner. One child: your UID → `true`

```
commish
  └─ <your-uid>: true
```

**`/emailToFid`** — which inbox owns which franchise. Keys are emails **with every dot replaced by a comma** (Firebase forbids dots in keys), values are franchise ids:

| fid | franchise |
|---|---|
| f01 | Drake Draaaake? |
| f02 | Kweef Farts |
| f03 | Syd Sweeney's Denim Jeans |
| f04 | G. O. A. T. |
| f05 | THE Vagitarians |
| f06 | Mud Dogs |
| f07 | Bindgamer3 |
| f08 | Bijan Mustard (you) |
| f09 | Mean Machine |
| f10 | Return of The Mac |

Example: `bryan.weimerskirch@gmail.com` becomes the key `bryan,weimerskirch@gmail,com` with value `"f08"`.

Use the email each owner will actually tap the sign-in link from. Both maps are deliberately **unwritable from any browser** — an owner cannot claim someone else's franchise, and being commissioner is not something a client can assert about itself.

---

## 2. Rehearse in staging (do this before draft night)

Staging is the same site, same code, but its draft state lives at `drafts/staging/2026` — nothing you do here touches the real draft.

1. You + one owner open `wadi.solutions/draftboard.html?env=staging`, both tap **Connect**, sign in via email link.
2. You'll see **⚡ Start live draft** in the strip → tap it → confirms → writes the 160 slots and seeds keepers.
3. Make picks, let the other owner pick, try picking out of turn (they get "✕ Not your pick"), try the same slot at the same time, undo one.
4. Start the clock from your clock bar — the other device shows the same countdown in its strip.
5. To reset staging and rehearse again: console → Data tab → delete `drafts/staging/2026`.

The orange striped banner at the bottom is how you know you're in staging. Close the tab and it's gone.

## 3. Draft night (Sun Aug 30, 5:30pm MT) — order of operations

1. **Keepers lock Fri Aug 29.** Run setup AFTER that: setup snapshots the keeper list into the shared board. (If a keeper changes after setup, delete `drafts/prod/2026` in the console and run setup again.)
2. On `wadi.solutions/draftboard.html` (no `?env` — the strip should NOT show the staging banner), tap **⚡ Start live draft**. Keeper picks appear pre-filled, cursor sits at the first real pick.
3. Owners open the draft board on any device → **Connect** → tap the emailed link. The strip shows "you are ⟨their team⟩" and "N of 10 owners online."
4. Run your clock exactly as before (it's still commissioner-only). Every screen counts down together. Auto-pick still fires from your machine only, and its picks go through the same server-enforced path.
5. Phone dies mid-pick? Pick for them from your board — their board (and everyone's) shows "picked for you by the commissioner."
6. Undo works from your board only, one pick at a time, and every screen follows.

## 4. What the strip states mean

- `○ Live draft: not connected` — picks made here stay on this device (pre-connect)
- `✉ Link sent to …` — check that inbox **on this device**
- `● Live · you are ⟨team⟩ · N of 10 owners online` — connected and shared
- `⟳ reconnecting — board may be stale` — network dropped; Firebase re-syncs itself
- `✕ ⟨Team⟩'s pick was already made — the board has moved on` — the race; normal, nothing lost
- `✕ Not your pick — ⟨Team⟩ is on the clock` — turn enforcement (server would reject it anyway)

Every state is words + a glyph, never color alone, per the site's own Law 2.

## 5. Open items (flagged for the design memo, not blockers)

- The rejected-pick visual treatment is the minimal words-in-strip version — the full vocabulary is §5.2 of the Aug 3 memo, still with Design (answer due Aug 14).
- The countdown lives in the strip on owners' screens; moving it into the on-the-clock cell is the agreed next cut, not yet built.
- MOCK mode is completely untouched — it's still a private simulator, and live state can't leak into it (tested).
