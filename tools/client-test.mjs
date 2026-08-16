/**
 * Client-side audit — runs the REAL js/*.js modules against a minimal DOM,
 * fake fetch, fake IndexedDB and fake localStorage. Catches wiring bugs that
 * static checks miss: missing ids, bad routing, tier badges, static-build degrade.
 *
 *   node tools/client-test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pass = [];
const fail = [];
const t = (name, cond) => (cond ? pass : fail).push(name);

/* ------------------------------- tiny DOM -------------------------------- */

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const idsInHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

class El {
  constructor(id = "", tag = "div") {
    this.id = id; this.tagName = tag.toUpperCase();
    this.children = []; this.listeners = {}; this.dataset = {};
    this._html = ""; this._text = ""; this.value = ""; this.hidden = false;
    this.disabled = false; this.files = []; this.style = {}; this.attrs = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c)
    };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); }
  dispatch(ev, payload = {}) {
    for (const fn of this.listeners[ev] || []) fn({ preventDefault() {}, target: this, ...payload });
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() {}
  click() { this.dispatch("click"); }
  requestSubmit() { this.dispatch("submit"); }
  closest() { return null; }
  querySelector() { return null; }
  appendChild(c) { this.children.push(c); return c; }
  getContext() { return { drawImage() {}, canvas: this }; }
  toDataURL() { return "data:image/jpeg;base64,QUJD"; }
}

const els = new Map();
for (const id of idsInHtml) els.set(id, new El(id));

const documentStub = {
  getElementById: (id) => els.get(id) || null,
  createElement: (tag) => new El("", tag),
  addEventListener() {},
  removeEventListener() {},
  body: new El("body", "body"),
  activeElement: null,
  hidden: false
};

const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

/* ------------------------------- fake fetch ------------------------------- */

const seedFiles = {
  "./data/payments.json": JSON.parse(fs.readFileSync(path.join(root, "data/payments.json"), "utf8")),
  "./data/shipping.json": JSON.parse(fs.readFileSync(path.join(root, "data/shipping.json"), "utf8")),
  "./data/general.json": JSON.parse(fs.readFileSync(path.join(root, "data/general.json"), "utf8"))
};

const calls = { chat: 0, resolve: 0, dictionary: 0 };
let mode = "cloudflare"; // or "static"
let lastChatBody = null;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (seedFiles[u]) return jsonRes(seedFiles[u]);
  if (u.includes("api/dictionary")) {
    calls.dictionary++;
    if (mode === "static") return new Response("<!doctype html>404", { status: 404 });
    return jsonRes({ entries: [], count: 0 });
  }
  if (u.includes("api/chat")) {
    calls.chat++;
    lastChatBody = JSON.parse(opts.body);
    if (mode === "static") return new Response("<!doctype html>404", { status: 404 });
    return jsonRes({
      tier: "ai", section: "general", symptom: "Researched answer",
      diagnosis: "A plausible diagnosis that is long enough to be realistic for the validator.",
      fix_steps: ["Open your admin.", "Read the banner.", "Make the change and save."],
      tags: ["general"], target_ui_hint: "Admin home", confidence: 0.7,
      related: [], message_id: "msg_test", disclaimer: "Storescope can't change anything in your store."
    });
  }
  if (u.includes("api/resolve")) {
    calls.resolve++;
    if (mode === "static") return new Response("<!doctype html>404", { status: 404 });
    return jsonRes({ saved: true, key: "issue:general:x", mode: "created" });
  }
  throw new Error("unexpected fetch " + u);
};
function jsonRes(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

/* ---------------------------- fake IndexedDB ------------------------------ */

const idbData = new Map();
globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({ createIndex() {} }),
        transaction: () => ({
          objectStore: (name) => ({
            put: (v) => { idbData.set(name + ":" + v.id, v); return okReq(); },
            add: (v) => { idbData.set(name + ":" + Math.random(), v); return okReq(); },
            get: (k) => okReq(idbData.get(name + ":" + k)),
            getAll: () => okReq([]),
            clear: () => okReq(),
            index: () => ({ openCursor: () => okReq(null) })
          })
        })
      };
      req.result = db;
      req.onsuccess?.();
    }, 0);
    return req;
  }
};
function okReq(result) {
  const r = { result };
  setTimeout(() => r.onsuccess?.(), 0);
  return r;
}

/* ------------------------------- globals ---------------------------------- */

const fuseSrc = fs.readFileSync(path.join(root, "js/vendor/fuse.min.js"), "utf8");
const ctx = { window: {}, self: {} };
vm.createContext(ctx);
vm.runInContext(fuseSrc + "\nwindow.Fuse = Fuse;", ctx);
const Fuse = ctx.Fuse || ctx.window.Fuse;

globalThis.window = {
  Fuse,
  addEventListener() {},
  location: { href: "https://example.com/", search: "" },
  SpeechRecognition: undefined,
  webkitSpeechRecognition: undefined
};
globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
globalThis.navigator = { onLine: true, language: "en-CA" };
globalThis.URL.createObjectURL = () => "blob:x";
globalThis.URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async () => ({ width: 800, height: 600 });
globalThis.Response ||= (await import("node:buffer")).Blob && Response;

/* --------------------------------- tests ---------------------------------- */

const dict = await import(path.join(root, "js/dictionary.js"));
const chat = await import(path.join(root, "js/chat.js"));
const chatUi = await import(path.join(root, "js/chat-ui.js"));
const consent = await import(path.join(root, "js/consent.js"));

// every id chat-ui touches must exist in index.html
const uiSrc = fs.readFileSync(path.join(root, "js/chat-ui.js"), "utf8");
const touched = [...uiSrc.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
const missing = [...new Set(touched)].filter((id) => !idsInHtml.has(id));
t(`chat-ui touches only real ids (${missing.join(", ") || "none missing"})`, missing.length === 0);

/* ---- Cloudflare build ---- */
mode = "cloudflare";
const loaded = await dict.loadDictionaries();
t("dictionary loads seed entries", loaded.entries.length === 48);
t("runtime.api detected as available", dict.runtime.api === true);

const deps = {
  getEntries: () => loaded.entries,
  getFuse: () => dict.buildIndex(loaded.entries),
  isReady: () => true,
  toast: () => {},
  onShare: () => {}
};
chatUi.mountChat(deps);
await new Promise((r) => setTimeout(r, 20));

// 1. confident dictionary query must NOT hit the network
const before = calls.chat;
await chat.sendMessage({ text: "your payouts are temporarily on hold" });
const dictMsg = chat.chatState.messages.at(-1);
t("confident query answers from dictionary", dictMsg.tier === "dictionary");
t("confident query makes zero network calls", calls.chat === before);
t("dictionary answer carries steps", dictMsg.answer.fix_steps.length >= 3);

// 2. unknown query goes to the worker
await chat.sendMessage({ text: "the moon is upside down in my admin somehow" });
const aiMsg = chat.chatState.messages.at(-1);
t("unknown query routes to the worker", calls.chat === before + 1);
t("worker answer is tagged AI researched", aiMsg.tier === "ai");
t("worker gets conversation history", Array.isArray(lastChatBody.history) && lastChatBody.history.length > 0);
t("worker gets dictionary context", Array.isArray(lastChatBody.context_entries));

// 3. image always goes to the worker, even with a perfect dictionary match
const beforeImg = calls.chat;
await chat.sendMessage({ text: "your payouts are temporarily on hold", file: { name: "shot.png" } });
t("image message always calls the worker", calls.chat === beforeImg + 1);
t("image is sent as base64", Boolean(lastChatBody.image?.b64));
t("image is jpeg re-encoded", lastChatBody.image.mime === "image/jpeg");

// 4. resolution
const resolveBefore = calls.resolve;
const res = await chat.markResolved(aiMsg.id);
t("This fixed it saves an AI answer", calls.resolve === resolveBefore + 1 && res.saved === true);
const skip = await chat.markResolved(dictMsg.id);
t("dictionary answers are not re-saved", skip.saved === false && skip.reason === "already-in-dictionary");

// 5. rendering
const thread = els.get("chatThread");
t("thread renders bubbles", thread.innerHTML.includes("bubble"));
t("badges render", /AI researched|Dictionary/.test(thread.innerHTML));
t("disclaimer on every answer", thread.innerHTML.includes("can&#39;t change anything in your store") ||
  thread.innerHTML.includes("can't change anything in your store"));
t("primary action present", thread.innerHTML.includes("This fixed it"));
t("html is escaped", !thread.innerHTML.includes("<script>"));

// XSS: a hostile dictionary/model answer must not inject markup
await chat.sendMessage({ text: '<img src=x onerror="alert(1)">' });
t("user text is escaped in the bubble", !thread.innerHTML.includes('onerror="alert(1)"'));

/* ---- static build (GitHub Pages / offline zip) ---- */
mode = "static";
dict.runtime.api = null;
const staticLoad = await dict.loadDictionaries();
t("static build still loads the playbook", staticLoad.entries.length === 48);
t("runtime.api detected as unavailable", dict.runtime.api === false);

chat.newThread();
const staticChatBefore = calls.chat;
await chat.sendMessage({ text: "your payouts are temporarily on hold" });
t("static build answers from the dictionary", chat.chatState.messages.at(-1).tier === "dictionary");
t("static build makes no chat calls", calls.chat === staticChatBefore);
t("static build explains itself once", chat.chatState.messages.some((m) => m.role === "system" && /built-in playbook only/.test(m.text)));

await chat.sendMessage({ text: "something nobody has ever asked before xyzzy" });
const staticUnknown = chat.chatState.messages.at(-1);
t("static build degrades to local tips", ["local", "fallback"].includes(staticUnknown.tier));
t("static build never errors out", staticUnknown.answer.fix_steps.length >= 3);
t("static build still makes no chat calls", calls.chat === staticChatBefore);

const staticResolve = await chat.markResolved(staticUnknown.id);
t("static build does not attempt a KV write", staticResolve.reason === "static");

/* ---- consent ---- */
store.delete("ss_img_consent");
t("consent starts off", consent.hasImageConsent() === false);
store.set("ss_img_consent", "1");
t("consent persists", consent.hasImageConsent() === true);
consent.revokeImageConsent();
t("consent is revocable", consent.hasImageConsent() === false);

/* --------------------------------- report --------------------------------- */

console.log(`\nPASS ${pass.length}`);
if (fail.length) {
  console.log("\nFAIL:");
  for (const f of fail) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("All client tests passed.\n");
