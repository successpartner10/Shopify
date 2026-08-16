Storescope — offline build
==========================

Run it:
    unzip Storescope-offline.zip
    cd Storescope-offline
    python3 -m http.server 4173
    open http://localhost:4173/

What works offline
------------------
  Tap / screen capture      yes (secure context; localhost counts)
  Screenshot upload + OCR   yes (OCR needs one online load to cache Tesseract)
  Typed Ask                 yes
  Ask Storescope chat       yes, DICTIONARY ANSWERS ONLY
  Dictation (mic)           yes, in browsers with Web Speech

What does NOT work in this build
--------------------------------
This zip is the static app. There is no Cloudflare Worker behind it, so the chat
cannot do AI research or read a screenshot with vision. It says so in the chat
window the first time you ask. Attached screenshots are read by the on-device OCR
and matched against the playbook instead — nothing leaves your machine.

For the full AI chat, run the Cloudflare version:
    npx wrangler pages dev .
or use the deployed site.

Storescope has no Shopify OAuth or Admin API in any build. It diagnoses and
advises only. It never changes anything in your store.
