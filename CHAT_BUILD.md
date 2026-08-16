# Storescope AI Chat — BUILD LOG (resume file)

**Purpose:** if the session dies, read this file top to bottom and you can pick up
exactly where the build stopped. Updated after every completed step.

- Repo: `github.com/successpartner10/Shopify` → cloned at `/home/user/repo`
- Plan: `/home/user/storescope-chat-plan.md` (decisions locked in §0.1)
- Last updated: **BUILD COMPLETE — nothing left in code.** Audit 384/384, worker tests 57/57,
  dev server verified end to end. Remaining work is account-side only (KV namespace ids + deploy).
- Dev server: `npm run dev` (port 4173)
- Tests: `npm test` → audit **399 OK** + worker **74 PASS** + client **46 PASS**
- **Pushed to GitHub `main`** — commit `35ecfbf`, 29 files, +3,589 / −16.
- **GitHub Pages LIVE** → https://successpartner10.github.io/Shopify/ (static build)
- **Cloudflare Pages NOT yet redeployed** — needs `CLOUDFLARE_ACCOUNT_ID` +
  `CLOUDFLARE_API_TOKEN`. `storescope-cwl.pages.dev` is still the old build with no chat.

---

## Where it is deployed

| Target | URL | Chat capability | State |
|---|---|---|---|
| GitHub Pages | https://successpartner10.github.io/Shopify/ | dictionary + on-device OCR only | **live** |
| Cloudflare Pages | https://storescope-cwl.pages.dev/ | full: AI research + vision + AGENT_KV | **old build — redeploy pending** |
| Offline zip | `Storescope-offline.zip` (546 KB, 42 files) | dictionary + on-device OCR only | in repo |
| Local dev | `npm run dev` → :4173 | full, with fake KV + canned model | on demand |
| Local Cloudflare | `npm run dev:cf` | full, real Workers AI + real KV | needs `wrangler login` |

Why GitHub Pages cannot run the full chat: Pages serves static files only, so
`functions/api/*` never executes and `/api/dictionary` returns 404. The app detects that
and degrades — it does not error. Verified live: `index 200`, `js/chat.js 200`,
`api/dictionary 404`.

**To finish the Cloudflare side** (10 min, needs your credentials):
```bash
npx wrangler login
npx wrangler kv namespace create AGENT_KV
npx wrangler kv namespace create AGENT_KV --preview
# paste both ids into wrangler.toml, replacing REPLACE_WITH_*
npx wrangler pages deploy . --project-name=storescope --branch=preview
```
Or add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` as GitHub repo secrets and let
`.github/workflows/deploy.yml` do it on the next push.

---

## Session end state — read this first

**Everything below is already written and passing.** If you are resuming, you do NOT need to
write any feature code. Run the three commands in *Resume instructions* to confirm, then do
the account-side steps in *What is actually left*.

### Files added (2,239 lines)

| File | Lines | Role |
|---|---|---|
| `functions/_lib/match.js` | 173 | server matcher, both schemas, pending damping |
| `functions/_lib/guard.js` | 135 | system prompt, action-claim filter, PII scrub, JSON validator |
| `functions/_lib/kv.js` | 250 | AGENT_KV keys, rate limit, threads, `saveIssue` create/merge |
| `functions/api/chat.js` | 277 | dictionary context → Workers AI → validate → degrade ladder |
| `functions/api/resolve.js` | 59 | "This fixed it" → scrub → validate → KV write |
| `functions/api/dictionary.js` | 42 | seed ∪ KV, ETag, never throws |
| `js/chat.js` | 411 | routing, thresholds, image prep, OCR, offline outbox |
| `js/chat-ui.js` | 267 | sheet, bubbles, badges, composer, one primary action |
| `js/chat-voice.js` | 83 | Web Speech dictation into the composer |
| `js/consent.js` | 70 | one-time screenshot consent + revoke |
| `tools/chat-test.mjs` | 332 | 57 worker-logic tests, fake KV + fake AI |
| `tools/dev-server.mjs` | 140 | Node dev server running `functions/`, canned model |
| `tools/client-test.mjs` | 380 | 46 client tests: real modules on a fake DOM/fetch/IDB |
| `js/fingerprint.js` | 150 | dHash screen recognition, no image ever stored |
| `tools/make-zip.mjs` | 25 | rebuilds `Storescope-offline.zip` from source |
| `.github/workflows/deploy.yml` | 75 | test-then-deploy to Cloudflare Pages |

### Files modified (+469 / −12)

`.gitignore` (+3, ignores `.dev-kv.json`) · `README.md` (+55, "Ask Storescope" section) ·
`css/app.css` (+131) · `index.html` (+69) · `js/app.js` (+26, mounts chat, Cmd+K) ·
`js/dictionary.js` (+97, KV merge / `scoreQuery` / `PENDING_DAMP`) ·
`js/history.js` (+14, IDB v2) · `sw.js` (+8, v1.3.0, skips `/api/*`) ·
`tools/audit.mjs` (+63, 43 new assertions) · `wrangler.toml` (+15, bindings).

### Git state
Committed and pushed to `main` as `35ecfbf` (29 files, +3,589 / −16). Working tree clean
apart from doc updates made after the push.

**Security note:** the GitHub PAT used for that push was pasted into chat and should be
revoked at github.com/settings/tokens. It is not stored in any file in this repo.

---

## Locked decisions (do not re-litigate)

| # | Decision |
|---|---|
| 1 | **Cloudflare Workers AI.** `@cf/meta/llama-3.2-11b-vision-instruct` when an image is attached, `@cf/meta/llama-3.1-8b-instruct` for text-only. Binding `[ai] binding = "AI"`. No vendor key. |
| 2 | **Chat-created entries save as `status:"pending"`.** Scored ×0.85, badged "Dictionary (community)", auto-promote to `published` after 3 confirmations, `review:queue` for manual approval. Tap/Screenshot flows use `published` only. |
| 3 | **Mic = dictation button inside the chat composer** (Web Speech API). Fills the input, never auto-sends, hidden when unsupported. No standalone Voice flow. |
| 4 | **One-time image consent dialog on first attach** (`ss_img_consent` in localStorage, revocable from Privacy panel) + updated Privacy panel copy. |

Thresholds (single config block in `js/chat.js`): instant-answer `0.62`, worker-context floor `0.46`, dedupe-merge `0.75`, auto-promote `3` confirmations, rate limit `30/hr`, LLM timeout `12s`.

---

## Build checklist

| Step | Files | Status |
|---|---|---|
| 1 | `functions/_lib/match.js`, `_lib/guard.js`, `_lib/kv.js` | ✅ **DONE** |
| 2 | `functions/api/dictionary.js`, `api/chat.js`, `api/resolve.js` | ✅ **DONE** |
| 3 | `wrangler.toml` (AGENT_KV + AI bindings) | ✅ **DONE** |
| 4 | `js/dictionary.js` edit (merge KV over seed, `scoreQuery`) | ✅ **DONE** |
| 5 | `js/history.js` edit (DB v2: `threads` + `outbox` stores, export `openDb`) | ✅ **DONE** |
| 6 | `js/chat.js` (state machine, routing, offline queue) | ✅ **DONE** |
| 7 | `js/chat-ui.js` (sheet, bubbles, composer, badges) | ✅ **DONE** |
| 8 | `js/chat-voice.js` (dictation), `js/consent.js` (image consent) | ✅ **DONE** |
| 9 | `index.html` (FAB, chat sheet, consent dialog, privacy copy) | ✅ **DONE** |
| 10 | `css/app.css` (chat styles using existing tokens) | ✅ **DONE** |
| 11 | `js/app.js` (mount chat, Cmd+K), `sw.js` (v1.3.0, skips `/api/*`) | ✅ **DONE** |
| 12 | `tools/audit.mjs` +43 checks, `tools/chat-test.mjs`, `tools/dev-server.mjs`, README | ✅ **DONE** |

---

## Step 1 — DONE: Worker shared libs

### `functions/_lib/match.js` (173 lines)
Dependency-free server twin of `js/dictionary.js` (no Fuse in a Worker).
- `normalizeEntry(raw)` — accepts **both** shapes and returns an object carrying both
  field families: seed `{id, category, match_phrases, synonyms, tags, explanation, steps}`
  ↔ KV `{id, section, symptom, tags, diagnosis, fix_steps}`. This is the bridge between
  the schema in the brief and the schema actually on disk.
- `rank(entries, query, {preferredCategory, limit})` → `[{entry, score}]` desc.
  Scoring mirrors the client: phrase hits `0.35 + hits*0.12 + longest/80`, category boost
  `+0.15`, priority boost, plus a token-overlap fuzzy fallback standing in for Fuse.
  **`status:"pending"` entries are multiplied by 0.85** (decision 2). `rejected` skipped.
- `detectScreen`, `slugify`, `shortHash` (FNV-1a, 4 chars) helpers.

### `functions/_lib/guard.js` (135 lines)
- `SYSTEM_PROMPT` — hard limits ("no access… cannot change, enable, disable, refund,
  connect, configure"), style rules, context rules ("don't restate an existing entry as
  new"), and a JSON-only output contract.
- `claimsAction(text)` — three regexes: past-tense action claims, access claims
  ("I checked your store"), future claims ("I'll enable…").
- `scrub(text)` — strips `shpat_*`/`sk_live_*` keys, emails, card-like and phone-like digits
  before anything reaches KV.
- `extractJson(raw)` — brace-depth scanner, string/escape aware, pulls the first JSON object
  out of a chatty Llama response.
- `validateAnswer(obj)` → `{ok, value}` / `{ok:false, error}`. Enforces section enum,
  symptom ≤90 chars, diagnosis ≥20 chars, 2–8 fix_steps (strips "1." prefixes), tag
  normalisation, confidence clamp — and **fails validation if `claimsAction` matches**,
  which is what triggers the single repair retry.
- `DISCLAIMER` string used in every AI response.

### `functions/_lib/kv.js` (250 lines)
Key map: `issue:{section}:{slug}`, `index:issues`, `chat:thread:{id}` (TTL 7d),
`chat:rate:{hash}:{yyyymmddhh}` (TTL 1h), `review:queue`.
- `json()`, `hasKv()` — **every KV path fails open**: no binding ⇒ endpoints still answer,
  app still works, nothing throws.
- `getIndex/putIndex`, `getKvEntries`, `getSeedEntries` (reads `/data/*.json` through
  `env.ASSETS`), `getAllEntries` (KV overrides seed by id).
- `checkRate` — 30/hr per `hash(ip+ua)`, fails open.
- `readThread` / `writeThread` — last 20 turns, 1200 chars each, 7-day TTL.
- `saveIssue(env, request, answer, meta)` — the learning loop:
  - **merge** when `rank ≥ 0.75`: appends the merchant's phrasing to `synonyms`,
    `hit_count++`, promotes pending→published at 3. A **seed** entry is never rewritten —
    it gets a KV override entry keyed off its id (`source:"seed+chat"`).
  - **create** otherwise: `source:"chat"`, `status:"pending"`, pushed onto `review:queue`.
- `mirror(entry)` — writes `category`/`explanation`/`steps` alongside
  `section`/`diagnosis`/`fix_steps` so **no client code needs field translation**.

---

## Steps 2-6 — DONE

### `functions/api/dictionary.js`
`GET /api/dictionary` → `{entries, count}`, seed ∪ KV (KV wins on id collision), weak ETag +
304 support, `max-age=60, stale-while-revalidate=600`. **Never throws** — on any error it
returns an empty list so the client silently stays on its static files.

### `functions/api/chat.js`
Models: `@cf/meta/llama-3.1-8b-instruct` (text), `@cf/meta/llama-3.2-11b-vision-instruct`
(image, raw bytes via `base64ToBytes`, not a data URL). 1.5 MB body cap, MIME allowlist
(png/jpeg/webp), 12 s timeout raced against `env.AI.run`, 30/hr rate limit → friendly 429.
Flow: rate → `getAllEntries` → `rank(top 3)` as context → thread history from KV (falls back
to the client's copy) → `buildUserPrompt` → `extractJson` → `validateAnswer` → **one repair
retry** with the validator's reason appended → `writeThread`.
Degrade ladder, never an error card: top dictionary entry ≥0.4 → `tier:"fallback"` with a
note; else `genericFallback(category)` with the same per-section tips the app already uses.
Response: `{tier, section, symptom, diagnosis, fix_steps, tags, target_ui_hint, related, confidence, message_id, model, disclaimer}`.

### `functions/api/resolve.js`
`scrub()` on question/symptom/diagnosis/steps → `validateAnswer` → second `claimsAction`
check → `saveIssue`. Without a KV binding it returns `{saved:false, reason:"no-kv"}` 200 so
chat keeps working. 422 on invalid or guard-tripped content.

### `wrangler.toml`
Appended `[[kv_namespaces]] binding="AGENT_KV"` (ids are **placeholders** — see gaps) and
`[ai] binding="AI"`.

### `js/dictionary.js` (edited)
Added `normalizeEntry()` (client twin of the server one), split `loadSeed()` out, and
`loadDictionaries({withKv=true})` now layers `./api/dictionary` over the seed by id with a
4 s abort and an offline short-circuit — **failure means seed-only, never a broken app**.
Added `PENDING_DAMP = 0.85` applied to both exact and fuzzy scores, and `scoreQuery()` which
the chat router uses so chat and Tap share one matcher. Existing exports unchanged.

### `js/history.js` (edited)
DB version 1 → **2**; upgrade creates `threads` (keyPath id, index updatedAt) and `outbox`
(autoIncrement). `openDb` is now exported and shared — history and chat must agree on the
version or IndexedDB throws `VersionError`.

### `js/chat.js` (new, ~380 lines)
`CHAT_CONFIG` = the single tuning block: `INSTANT 0.62`, `CONTEXT_FLOOR 0.46`,
`HISTORY_TURNS 8`, `MAX_IMAGE_PX 1280`, `IMAGE_QUALITY 0.72`, `REQUEST_TIMEOUT 15000`.
- `initChat({getEntries, getFuse, isReady, toast})`, `onChatChange(fn)` subscription,
  `chatState = {threadId, messages, busy, queued}`.
- `sendMessage({text, file})` implements the route table verbatim. Image ⇒ always Worker.
- `withFollowUpContext()` appends keywords from the last two turns for short follow-ups.
- `answerWithWorker()` downscales ≤1280px / JPEG 0.72 (canvas re-encode drops EXIF), runs
  **local Tesseract OCR first** via dynamic `import("./ocr.js")`, re-scores the dictionary on
  the OCR text for better context, then POSTs.
- `markResolved()` → `/api/resolve`; skips saving when the answer was already a dictionary hit.
  `markRetry()` sets the `retry` flag so the Worker won't repeat itself.
- Offline: message goes to the `outbox` store, `flushOutbox()` runs on `online`.
- Threads persist to IndexedDB **without image bytes** — only `{name}`.

## Steps 7-12 — DONE

### `js/chat-ui.js`
Badge map `dictionary | community | ai | fallback/local`, empty state with 3 tappable examples,
delegated click handling for `data-fixed` / `data-retry` / `data-share` / `data-example`,
paste-an-image support, attachment chip with thumbnail, `esc()` on every interpolation.
One primary action (`This fixed it`), two text links. Share reuses the app's existing drawer
via the `onShare` dep, so chat answers get `?fix=` links like any other result.

### `js/chat-voice.js`
Web Speech dictation. Feature-detected — `micBtn.hidden = true` when unsupported, so no
layout shift. Interim results stream into the input, appended after existing text; never
auto-sends. Handles `not-allowed` with a plain-language toast, stops on `visibilitychange`.

### `js/consent.js`
`ensureImageConsent()` returns a promise gating every attach and paste. `ss_img_consent`
in localStorage, Esc/backdrop = cancel, `wireConsentControls()` powers the revoke button in
the Privacy panel.

### `index.html`
Added `#chatFab`, the `#chatBack`/`#chatSheet` dialog, composer (`📎 #chatAttach`,
`🎤 #chatMic`, `#chatInput`, `#chatSend`), `#chatChip`, `#chatTyping`, `#chatQueued`,
and the `#consentBack` dialog. Privacy panel gained two bullets ("Chat is the one
exception…", PII scrubbing) plus `#consentRevoke`.

### `css/app.css`
~150 lines appended using only existing tokens (`--mint`, `--surface`, `--line`…).
Right-side 460px panel ≥760px, full-screen below. FAB hides while the sheet is open,
respects `env(safe-area-inset-*)`. 44px touch targets. Typing dots respect
`prefers-reduced-motion`.

### `js/app.js` / `sw.js`
`mountChat({getEntries, getFuse, isReady, toast, onShare})` runs after the dictionary loads,
plus `wireConsentControls(toast)` and a `Cmd/Ctrl+K` shortcut. KV-fetch errors no longer
raise the "dictionaries failed" toast (seed-only is a valid state).
`sw.js` → v1.3.0, precaches the four new modules, and **returns early for `/api/*`** so
chat responses are never served from cache.

### Tests / tooling
- `tools/audit.mjs` — +43 assertions: all chat DOM ids exist, thresholds are 0.62/0.46/0.85,
  images always go to the Worker, KV writes all five schema fields, guard + disclaimer copy
  present in worker/UI/HTML, sw skips `/api/`, bindings declared. **384 OK**, 1 warn
  (placeholder KV ids — expected until you create the namespaces).
- `tools/chat-test.mjs` — **57 passing** logic tests with a fake KV / fake AI: matcher
  scores, pending damping, guard regexes, one-repair-retry, degrade ladder with no AI binding,
  vision byte payload, 415 on bad MIME, rate limit at exactly 30, create-vs-merge dedupe,
  seed entries never rewritten, PII scrub, auto-promote at 3, no-KV graceful paths.
- `tools/dev-server.mjs` — Node-only dev server that runs `functions/` with a disk-backed
  fake `AGENT_KV` (`.dev-kv.json`) and a canned model. `node tools/dev-server.mjs 4173`.

## Verified behaviours
- `GET /api/dictionary` returns 48 seed entries merged with KV, both schemas on every row.
- `POST /api/chat` returns a guard-clean answer with `related` dictionary ids attached.
- Removing the AI binding still returns usable steps (tier `fallback`), never an error card.
- Confirming a fix that duplicates `payments-identity-verification-006` **merges** rather
  than creating a second entry; a genuinely new problem creates a `pending` entry and lands
  in `review:queue`.

## Resume instructions

```bash
cd /home/user/repo
node tools/audit.mjs        # expect 384 OK
node tools/chat-test.mjs    # expect PASS 57
node tools/dev-server.mjs 4173
```
**The build is complete.** What is left is account-side, not code:

1. `npx wrangler kv namespace create AGENT_KV` and `… --preview`, paste both ids into
   `wrangler.toml` (they are placeholders right now — the audit warns about this).
2. `npx wrangler pages deploy . --project-name=storescope --branch=preview` and click through:
   dictionary answer → AI answer → screenshot answer → This fixed it.
3. Confirm Workers AI is enabled on the account (no key needed, just the `[ai]` binding).
4. Promote to production once the preview KV has a few sane entries.

Optional follow-ups, none blocking: a small `/review` page over `review:queue`, streaming
token output, and analytics on which tier answered.

## What is actually left (account-side, ~10 minutes)

1. **Create the namespaces** and paste both ids into `wrangler.toml` — they are placeholders
   right now, which is the single warning the audit prints:
   ```bash
   npx wrangler kv namespace create AGENT_KV
   npx wrangler kv namespace create AGENT_KV --preview
   ```
   Keep preview and production separate so test chatter never enters the real playbook.
2. **Confirm Workers AI is enabled** on the Cloudflare account. No API key — the `[ai]`
   binding in `wrangler.toml` is the whole configuration.
3. **Deploy to preview and click the four paths:**
   ```bash
   npx wrangler pages deploy . --project-name=storescope --branch=preview
   ```
   - "my payouts are on hold" → instant, badge **Dictionary**
   - "checkout is blank after installing an app" → badge **AI researched**
   - attach a screenshot → consent dialog once, then **AI researched**
   - tap **This fixed it** → toast, and the key appears in `review:queue`
4. **Promote to production** once the preview KV holds a few sane entries.

## Screen fingerprints (added after the first pass)

**Decision: store the fingerprint, never the screenshot.** A Shopify admin screenshot holds
customer names, payout figures and API keys, so a shared screenshot DB would mean per-image
consent, redaction, moderation and breach liability. A dHash is 8 bytes of gradient signs —
it cannot be turned back into an image, holds no personal data, and costs nothing to store.

### `js/fingerprint.js` (new, 150 lines)
- `computeFingerprint(canvas)` → `{v:1, dhash, tiles[4]}`. 9×8 grayscale dHash of the
  **content region only** (`x:18%, y:8%` crop) — hashing the whole frame would make every
  admin page look alike, because they share the left nav and top bar. Four quadrant hashes
  let a differently-cropped screenshot still match.
- `compareFingerprints(a,b)` → 0–0.95. Deliberately conservative: `≤6 bits → 0.9`,
  `≤10 → 0.75`, `≤14 → 0.6`, `≤18 with 3+ tile hits → 0.55`, else 0. Tile agreement adds
  0.05; tile *disagreement* subtracts 0.15, because a hash match with a layout mismatch is
  usually a coincidence. A wrong "same screen" call is worse than none.
- `matchFingerprint(entries, fp)` — pending entries damped ×0.85, same as text.
- Fails soft everywhere: a bad canvas returns `null` and the answer proceeds without it.

### Where it plugs in
- **Client, static build:** screenshot → fingerprint → if ≥0.75, answer instantly from the
  playbook with "Recognised this admin screen from the playbook, on your device."
  **No OCR, no network.** This is the case OCR handles worst — low-res or non-English shots.
- **Client, Cloudflare build:** fingerprint travels with the image and any local screen
  matches are sent as `screen_matches`.
- **Worker:** `rankByFingerprint()` merges screen hits into the text-ranked context (best
  score per entry wins), and the prompt tells the model a screen match is strong evidence
  of which page the merchant is on.
- **Model contract:** new optional `screen_summary` — one line naming the page and the
  visible problem, explicitly excluding names, emails, order numbers and amounts. Scrubbed
  by `guard.scrub()` before it is stored or returned.
- **KV:** `addFingerprint()` appends on create and on merge, skips anything ≥0.9 similar to
  a stored one, caps at **8 per entry**.

### Tests added (+17 worker, +13 client)
Hamming maths, identical/near/far screens, the tile-disagreement penalty, pending damping,
save round-trip, near-duplicate suppression, distinct-screen addition, worker context
injection, deterministic hashing from a fake canvas, "no image data in the fingerprint"
(<200 bytes serialised), and the static build answering a screenshot with zero network calls.

## Static build support (added after the first pass)

GitHub Pages and the offline zip have **no Worker**, so the chat had to degrade instead of
erroring. Added:
- `js/dictionary.js` exports `runtime = { api, kvCount }`. `loadDictionaries()` probes
  `./api/dictionary`; a 404 or unparseable response sets `runtime.api = false`.
- `js/chat.js` — when `runtime.api === false`: text answers come from the dictionary at any
  confidence (falling back to safe generic checks), and **screenshots are read by the
  on-device OCR** and matched to the playbook (`answerFromScreenshotLocally`). A one-time
  system message explains the limit in plain language.
- Same local-OCR path is now also the fallback when the Worker call *fails* with an image
  attached, instead of dropping to generic tips.
- `js/chat-ui.js` — no consent dialog in static mode, because the image never leaves the device.
- `markResolved()` returns `{reason:"static"}` rather than firing a doomed KV write.

## Three ways to deploy (pick one)

**A — GitHub Actions (recommended, no secrets ever leave your accounts).**
`.github/workflows/deploy.yml` is committed. Add two repo secrets —
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — then push, or run the workflow
manually and choose `preview` / `main`. It runs the audit and the 57 worker tests first,
and hard-fails if `wrangler.toml` still has placeholder KV ids.

**B — From your own machine.**
```bash
git clone https://github.com/successpartner10/Shopify && cd Shopify
npx wrangler login                       # opens a browser, no token to copy
npx wrangler kv namespace create AGENT_KV
npx wrangler kv namespace create AGENT_KV --preview
# paste both ids into wrangler.toml
npx wrangler pages dev .                 # real Workers AI + real KV, locally
npx wrangler pages deploy . --project-name=storescope --branch=preview
```

**C — Hand the agent scoped, short-lived credentials.** Possible but least safe: a token
pasted into chat is stored in the transcript. If you do it, scope it to
Pages:Edit + KV:Edit + Workers AI:Read, and delete it in the Cloudflare dashboard right after.

## Test suites (all green)

| Command | Count | Covers |
|---|---|---|
| `node tools/audit.mjs` | **399 OK**, 1 warn | files exist, DOM ids, thresholds 0.62/0.46/0.85, KV schema fields, guard + disclaimer copy, sw skips `/api/`, bindings declared. Warn = placeholder KV ids. |
| `node tools/chat-test.mjs` | **74 PASS** | fake KV + fake AI: matcher, pending damping, guard regexes, repair retry, degrade ladder, vision bytes, 415 bad MIME, rate limit at 30, create-vs-merge dedupe, PII scrub, auto-promote at 3, no-KV paths, **fingerprint save/dedupe/context** |
| `node tools/client-test.mjs` | **46 PASS** | real client modules on a fake DOM/fetch/IndexedDB: id wiring, dictionary answers with zero network calls, unknown → Worker, image always → Worker, resolve, bubble rendering, **HTML escaping / XSS**, static-build degrade, consent persistence, **screen recognition with no network** |

`npm test` runs all three.

## Known caveats (deliberate, not bugs)

- **Seed entries have no `symptom` field**, so chat titles them from `target_ui_hint` —
  headings read like "Settings > Payments > Payouts". Consistent with the existing result
  card. Changing it is a data edit to `data/*.json`, not code.
- **The dev server's model is canned.** The JSON contract, repair retry, and degrade ladder
  are all exercised, but Llama's real phrasing quality is unverified until step 3 above.
- **Workers AI has a daily free allocation.** When it runs out the Worker returns the closest
  playbook with a `Local tips` badge rather than an error — worth watching in the first week.
- **`.dev-kv.json`** is the local fake KV. Gitignored, safe to delete anytime.

## Optional follow-ups (none blocking)

- A tiny `/review` page over `review:queue` to approve or reject pending chat entries.
- Streaming tokens into the bubble (currently one answer card after a typing indicator —
  the deliberate choice, it matches the scan-result feel).
- Analytics on which tier answered, to tune the 0.62 instant-answer threshold with real data.
