# Storescope — Shopify Live Scanner

A progressive web app that looks at whatever Shopify admin screen a merchant is on — **via screen capture, never a camera** — and overlays real-time, step-by-step guidance to fix errors, finish setup, or understand a setting.

| | |
|---|---|
| **Live site (Cloudflare Pages — full AI chat)** | https://storescope-7bz.pages.dev/ |
| **GitHub Pages mirror (static — dictionary chat only)** | https://successpartner10.github.io/Shopify/ |
| **Source** | https://github.com/successpartner10/Shopify |
| **Offline zip** | [Storescope-offline.zip](./Storescope-offline.zip) |
| **Spec implemented** | Shopify Live Scanner PWA (dictionary-first MVP + arrow overlay + share) |
| **Share this app** | https://storescope-7bz.pages.dev/ |
| **Example shared fix** | https://storescope-7bz.pages.dev/?fix=payments-payout-hold-001 |

---

## What it does

Shopify admin has hundreds of screens. Merchants get stuck, tab out to Google, and lose the thread. Storescope keeps them in-flow:

1. Open Shopify admin in a browser tab.
2. Tap **Start scanning** and pick that tab (or upload an OS screenshot / try a sample).
3. Tap **What's wrong?** — a local playbook matches the banner text instantly.
4. Follow numbered steps. A mint arrow points at the control to use next.

Most answers never leave the device. The dictionary is the default path; a structured local fallback covers the long tail when nothing matches confidently.

---

## Live URL

**https://storescope-7bz.pages.dev/**

Install it: in Chrome / Edge open the live URL → **Install** in the app, or the browser menu → **Install Storescope**. It opens standalone and works offline for dictionary answers and history.

### Share the app

Tap **Share** in the header (or **Share app** on the home screen):

- **Share via device** — uses the phone/desktop share sheet (Messages, Slack, AirDrop, Mail)
- **Copy link** — `https://storescope-7bz.pages.dev/`
- **WhatsApp / Text / Email / X / LinkedIn / Telegram / Facebook**
- **QR code** — print or air-drop `icons/qr-app.png` so a teammate can scan it open

Shared **fix** links look like:

`https://storescope-7bz.pages.dev/?fix=payments-payout-hold-001`

They open the same numbered playbook on the other person's device. Search links work too: `?q=no+shipping+methods`.

Installed copies also register as an Android **share target** — share error text from another app into Storescope and it runs the dictionary.

---

## Two builds, one codebase

| | Cloudflare Pages | GitHub Pages / offline zip |
|---|---|---|
| Tap, Screenshot, typed Ask | yes | yes |
| Chat — dictionary answers | yes | yes |
| Chat — AI research | **yes** | no |
| Chat — screenshot with vision | **yes** | recognises known screens by fingerprint, else on-device OCR |
| Saving confirmed fixes to AGENT_KV | **yes** | no, kept on your device |

The static build has no Worker behind it. The app detects that on load (`runtime.api`)
and says so in the chat window the first time you ask, rather than throwing errors.
Attached screenshots are then read by the OCR that already ships with the app, so
nothing leaves your machine and no consent prompt appears.

## Ask Storescope (AI chat)

A fourth way in, alongside Tap, Screenshot, and typed Ask — it does not replace any of them.
The **Ask** button is fixed bottom-right on every screen (`Cmd/Ctrl + K` also opens it).

**What happens to each message**

| Situation | Path | Badge |
|---|---|---|
| Text, dictionary confidence ≥ 0.62 | answered on-device, no network | `Dictionary` |
| Text matching an unreviewed community entry | answered on-device, damped score | `Dictionary (community)` |
| Text, 0.46–0.62 | Worker + LLM, near-miss passed as context | `AI researched` |
| Text, < 0.46 | Worker + LLM, category context only | `AI researched` |
| **Any screenshot** | always Worker + vision model (local OCR runs first for context) | `AI researched` |
| AI unreachable / quota / offline | closest playbook or safe generic checks | `Local tips` |

### Screen fingerprints

Screenshots are never stored. When you confirm a fix that came from a screenshot, the entry
keeps a **dHash** instead: 8 bytes describing the light/dark gradient of the page content,
which cannot be turned back into an image and contains no customer data. Next time anyone
sends a screenshot of that same admin screen, Storescope recognises it — even offline, even
when OCR cannot read the text. Max 8 fingerprints per entry, near-duplicates skipped.

Tap **This fixed it** and the exchange is saved to `AGENT_KV` as a new entry
(`section, symptom, tags, diagnosis, fix_steps`, `source: "chat"`, `status: "pending"`).
Near-duplicates merge into the existing entry instead of creating a second one, and a
pending entry is promoted to `published` after three independent confirmations.

**Storescope has no Shopify OAuth and no Admin API.** Chat diagnoses and advises only.
That is enforced in three places: the system prompt, a server-side output filter that
rejects any "I've updated / I'll enable / I checked your store" phrasing (one repair retry,
then it falls back to the dictionary), and the UI copy on every answer.

**Screenshots in chat** are the one thing that leaves the device. The first attach shows a
consent dialog; the choice is stored in `localStorage` and revocable from the Privacy panel.
Images are downscaled to 1280px, re-encoded (which drops EXIF), sent for that single answer,
and never written to KV.

### Setup

```bash
npx wrangler kv namespace create AGENT_KV
npx wrangler kv namespace create AGENT_KV --preview   # keep prod and preview separate
# paste both ids into wrangler.toml
npx wrangler pages deploy . --project-name=storescope --branch=preview
```

Workers AI needs no key — the `[ai]` binding is enough.
Models: `@cf/meta/llama-3.2-11b-vision-instruct` (images), `@cf/meta/llama-3.1-8b-instruct` (text).

### Local development

```bash
npm run dev        # static files + functions/, fake KV, canned model, port 4173
npm run dev:cf     # wrangler pages dev . — real Workers AI + real KV
npm test           # audit + 57 worker tests + 33 client tests
npm run zip        # rebuild Storescope-offline.zip from source
```

Endpoints: `GET /api/dictionary`, `POST /api/chat`, `POST /api/resolve`.

---

## Offline zip

Download **[Storescope-offline.zip](./Storescope-offline.zip)** from this repo.

```bash
unzip Storescope-offline.zip
cd Storescope-offline
# Any local static server works. Screen capture requires a secure context
# (localhost is fine). Double-clicking index.html works for samples + typed search.
python3 -m http.server 4173
```

Then open http://localhost:4173/

Dictionary search, samples, history, and the app shell work fully offline after the first load (or from the zip). Live OCR loads Tesseract from a CDN the first time you scan a raw screenshot.

---

## How to use

### Desktop (best path)

1. Open Shopify admin (`admin.shopify.com`) in one tab.
2. Open Storescope and tap **Start scanning**.
3. In the browser share picker, choose the **Chrome tab** (or Window) that shows Shopify — not your whole desktop if you can avoid it.
4. Tap **What's wrong?**
5. Use **Next step** to walk the playbook. **Pause** before opening customer PII or API keys.

### Mobile / unsupported browsers

`getDisplayMedia()` is inconsistent on iOS Safari and some Android browsers. Use:

- the OS screenshot tool (not the camera), then **Upload screenshot**, or
- type the banner text into **Ask**, or
- tap a **sample screen** to learn the UI.

### Typed / tap-to-ask

The search box accepts merchant language (“why is my money stuck”, “no shipping methods”, “theme has 3 errors”). It matches `match_phrases`, `tags`, and `synonyms`.

---

## Feature audit (vs build spec)

| Spec item | Status | Notes |
|---|---|---|
| 3-step onboarding on first open | Done | Collapses after first scan/upload/sample; **How it works** stays one tap away |
| Screen capture only — no camera API | Done | `getDisplayMedia()` + image file upload. `accept="image/*"` is for screenshots, not `getUserMedia` |
| Floating overlay / live preview | Done | In-app stage with live video + SVG arrow. Document PiP helper is in `js/capture.js` for later chrome |
| On-demand **What's wrong?** | Done | No continuous AI polling |
| Dictionary-first architecture | Done | `payments.json`, `shipping.json`, plus catch-all `general.json` |
| Fuse.js fuzzy search | Done | Vendored at `js/vendor/fuse.min.js` (works offline) |
| Client-side OCR | Done | Tesseract.js from CDN when online; samples skip OCR |
| Structured fallback (same step UI) | Done | Local category playbooks — no API key, no screenshot upload |
| Session history (text only) | Done | IndexedDB; no images stored |
| Installable PWA + offline shell | Done | `manifest.json` + service worker precache |
| Pause scanning | Done | Freezes a still and disables the video track |
| Privacy notice | Done | Shown on first visit; copy states what is (not) stored |
| Opaque tip card + Next / Dismiss | Done | Solid card, not a ghost tooltip |
| Arrow pointing at target control | Done | Relative `arrow` coords on each playbook entry |
| Related / tap alternate playbooks | Done | Shown under the tip |
| Sample admin screens | Done | Payout hold, no rates, no provider, theme errors |
| Shareable app + playbook export | Done | Web Share API, copy link, socials, QR, `?fix=` deep links, `.md` download, Android share target |

Not in this MVP (listed as stretch in the spec): live vision-model API proxy, Meta/Pinterest/Collective dictionaries, multi-store profiles, auto-promotion of fallback answers.

---

## Architecture

```
index.html                 UI shell
css/app.css                Dark diagnostic theme
js/app.js                  Flow: capture → OCR/text → search → overlay
js/dictionary.js           Load JSON, Fuse index, phrase boost, fallback
js/capture.js              getDisplayMedia + stop + optional Document PiP
js/ocr.js                  Tesseract worker, frame downscale
js/history.js              IndexedDB playbook
js/samples.js              Demo screens + known text
js/vendor/fuse.min.js      Offline fuzzy search
data/payments.json         18 payout / gateway playbooks
data/shipping.json         18 rate / zone / label playbooks
data/general.json          12 domain / theme / tax / markets playbooks
samples/*.svg              Mock Shopify admin frames
sw.js                      Precache app shell + dictionaries
manifest.json              Standalone PWA
```

### Search order

1. Detect likely screen (payments / shipping / general) from extracted words.
2. Exact / substring match on `match_phrases` and `synonyms` (highest confidence).
3. Fuse.js across phrases, tags, explanation, admin path.
4. If confidence &lt; 0.46 → structured **local fallback** for that category (same numbered-step UI).

### Privacy

- Frames are transient. History stores **tip text only**.
- No Storescope backend. No Shopify API tokens.
- Pause before customer lists, payout bank forms, or app secret screens.
- First-run OCR may download Tesseract language data from a public CDN.

---

## Dictionary shape

```json
{
  "id": "payments-payout-hold-001",
  "category": "payments",
  "match_phrases": ["payouts are temporarily on hold"],
  "tags": ["payout", "hold"],
  "synonyms": ["money not arrived"],
  "explanation": "Plain language root cause.",
  "steps": ["Do this first.", "Then this."],
  "target_ui_hint": "Settings > Payments > Payouts",
  "arrow": { "x": 0.62, "y": 0.14 }
}
```

`arrow` is a 0–1 position on the captured frame so the pointer can sit on a known banner or button.

---

## Local development

```bash
git clone https://github.com/successpartner10/Shopify.git
cd Shopify
python3 -m http.server 4173
```

Open http://localhost:4173/ — HTTPS is not required on localhost for `getDisplayMedia`.

There is no build step. Edit JSON or JS and refresh.

---

## Hosting

**Public site:** [https://storescope-7bz.pages.dev/](https://storescope-7bz.pages.dev/) on **Cloudflare Pages** (free, no credit card). Deployed with Wrangler from this folder — GitHub does **not** need to be public.

```bash
npx wrangler pages deploy . --project-name=storescope
```

See [CLOUDFLARE.md](./CLOUDFLARE.md) for the token steps.

You can make `successpartner10/Shopify` **private** after this URL is live. GitHub Pages on the free plan would stop working; Cloudflare will not.

---

## Browser support

| Capability | Chrome / Edge | Firefox | Safari desktop | iOS Safari |
|---|---|---|---|---|
| App + dictionary + samples | Yes | Yes | Yes | Yes |
| Tab capture | Yes | Yes (window/screen) | Limited | No — use upload |
| Install PWA | Yes | Limited | Limited | Add to Home Screen |
| OCR on screenshot | Yes (online first) | Yes | Yes | Yes |

---

## Name

**Storescope** — seeing into the store admin. Other directions from the spec (Fixly, Shopscan, AdminEye) were not used.

---

## License

Use and adapt for merchant support tooling. Shopify and the Shopify admin UI are trademarks of Shopify Inc. Sample screens are schematic mockups, not official assets.
