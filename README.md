# Storescope — Shopify Live Scanner

A progressive web app that looks at whatever Shopify admin screen a merchant is on — **via screen capture, never a camera** — and overlays real-time, step-by-step guidance to fix errors, finish setup, or understand a setting.

| | |
|---|---|
| **Live site (GitHub Pages)** | https://successpartner10.github.io/Shopify/ |
| **Source** | https://github.com/successpartner10/Shopify |
| **Offline zip** | [Storescope-offline.zip](./Storescope-offline.zip) |
| **Spec implemented** | Shopify Live Scanner PWA (dictionary-first MVP + arrow overlay) |

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

**https://successpartner10.github.io/Shopify/**

Install it: in Chrome / Edge open the live URL → browser menu → **Install Storescope** (or the install icon in the address bar). It opens standalone, works offline for dictionary answers and history.

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

Not in this MVP (listed as stretch in the spec): live vision-model API proxy, Meta/Pinterest/Collective dictionaries, shareable playbook export, multi-store profiles, auto-promotion of fallback answers.

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

## GitHub Pages

The site is served from the `main` branch root (`/`).

- Repo: `successpartner10/Shopify`
- Pages URL: `https://successpartner10.github.io/Shopify/`
- `.nojekyll` is present so GitHub does not run Jekyll on the static files.

After a push, Pages usually updates within a minute.

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
