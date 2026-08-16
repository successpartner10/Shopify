import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const warn = [];
const ok = [];

function assert(cond, msg) {
  if (cond) ok.push(msg);
  else fail.push(msg);
}

const required = [
  "index.html", "404.html", "manifest.json", "sw.js", "README.md", ".nojekyll",
  "css/app.css", "js/app.js", "js/dictionary.js", "js/history.js", "js/ocr.js",
  "js/capture.js", "js/samples.js", "js/share.js", "js/vendor/fuse.min.js",
  "icons/qr-app.png",
  "data/payments.json", "data/shipping.json", "data/general.json",
  "samples/payout-hold.svg", "samples/no-shipping.svg", "samples/no-provider.svg",
  "samples/theme-errors.svg", "icons/favicon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "js/chat.js", "js/chat-ui.js", "js/chat-voice.js", "js/consent.js",
  "functions/api/chat.js", "functions/api/resolve.js", "functions/api/dictionary.js",
  "functions/_lib/match.js", "functions/_lib/guard.js", "functions/_lib/kv.js",
  "tools/chat-test.mjs", "tools/client-test.mjs", "tools/dev-server.mjs",
  "Storescope-offline.zip", ".github/workflows/deploy.yml"
];
for (const f of required) {
  assert(fs.existsSync(path.join(root, f)), `exists ${f}`);
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
const ids = [...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
const uniqueIds = [...new Set(ids)];
for (const id of uniqueIds) {
  if (id === "startBtn2") continue;
  assert(html.includes(`id="${id}"`), `html has #${id}`);
}

const payments = JSON.parse(fs.readFileSync(path.join(root, "data/payments.json"), "utf8"));
const shipping = JSON.parse(fs.readFileSync(path.join(root, "data/shipping.json"), "utf8"));
const general = JSON.parse(fs.readFileSync(path.join(root, "data/general.json"), "utf8"));
const entries = [...payments, ...shipping, ...general];
assert(payments.length >= 15, `payments count ${payments.length} >= 15`);
assert(shipping.length >= 15, `shipping count ${shipping.length} >= 15`);
assert(general.length >= 8, `general count ${general.length} >= 8`);

const idsSet = new Set();
for (const e of entries) {
  assert(e.id && !idsSet.has(e.id), `unique id ${e.id}`);
  idsSet.add(e.id);
  assert(Array.isArray(e.steps) && e.steps.length >= 3, `steps on ${e.id}`);
  assert(Array.isArray(e.match_phrases) && e.match_phrases.length, `phrases on ${e.id}`);
  assert(e.explanation && e.target_ui_hint, `copy on ${e.id}`);
  assert(e.arrow && typeof e.arrow.x === "number", `arrow on ${e.id}`);
}

const fuseSrc = fs.readFileSync(path.join(root, "js/vendor/fuse.min.js"), "utf8");
const ctx = { window: {}, self: {} };
vm.createContext(ctx);
vm.runInContext(fuseSrc + "\nwindow.Fuse = Fuse;", ctx);
const Fuse = ctx.Fuse || ctx.window.Fuse;
const fuse = new Fuse(entries, {
  includeScore: true,
  threshold: 0.38,
  ignoreLocation: true,
  keys: [
    { name: "match_phrases", weight: 0.45 },
    { name: "synonyms", weight: 0.25 },
    { name: "tags", weight: 0.15 },
    { name: "explanation", weight: 0.1 }
  ]
});

function phraseHits(entry, hay) {
  let hits = 0;
  for (const phrase of [...entry.match_phrases, ...entry.synonyms]) {
    if (phrase.length >= 4 && hay.includes(phrase.toLowerCase())) hits += 1;
  }
  return hits;
}
function search(q) {
  const hay = q.toLowerCase();
  const exact = [];
  for (const entry of entries) {
    const hits = phraseHits(entry, hay);
    if (hits) exact.push({ entry, score: 0.5 + hits * 0.15 });
  }
  exact.sort((a, b) => b.score - a.score);
  if (exact[0]) return exact[0].entry.id;
  const r = fuse.search(q, { limit: 1 })[0];
  return r?.item.id || null;
}

const expect = [
  ["your payouts are temporarily on hold", "payments-payout-hold-001"],
  ["why is my money stuck", "payments-payout-hold-001"],
  ["this store is currently unable to accept payments", "payments-provider-not-connected-002"],
  ["there are no shipping rates available", "shipping-no-methods-001"],
  ["customer can't choose shipping", "shipping-no-methods-001"],
  ["theme has 3 errors", "general-theme-errors-002"],
  ["domain not verified", "general-domain-not-verified-001"],
  ["invalid api key", "payments-api-key-013"],
  ["test mode", "payments-test-mode-003"],
  ["chargeback", "payments-chargeback-005"]
];
for (const [q, id] of expect) {
  const got = search(q);
  assert(got === id, `search "${q}" -> ${got} (want ${id})`);
}

const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
assert(sw.includes("./data/payments.json"), "sw precaches payments");
assert(html.includes('type="module" src="./js/app.js"'), "module entry");
assert(!html.includes("getUserMedia"), "no camera API in html");
assert(!app.includes("getUserMedia"), "no camera API in app");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert(manifest.display === "standalone", "manifest standalone");
assert(manifest.start_url.startsWith("./"), "relative start_url");

/* ── AI chat tier ──────────────────────────────────────────────────────── */

const chatIds = [
  "chatFab", "chatBack", "chatSheet", "chatThread", "chatForm", "chatInput",
  "chatAttach", "chatMic", "chatSend", "chatFile", "chatChip", "chatChipThumb",
  "chatChipName", "chatChipRemove", "chatTyping", "chatQueued", "chatMicStatus",
  "chatClose", "chatNew", "consentBack", "consentAccept", "consentCancel", "consentRevoke"
];
for (const id of chatIds) assert(html.includes(`id="${id}"`), `html has #${id}`);

const chatJs = fs.readFileSync(path.join(root, "js/chat.js"), "utf8");
const chatUi = fs.readFileSync(path.join(root, "js/chat-ui.js"), "utf8");
const guardJs = fs.readFileSync(path.join(root, "functions/_lib/guard.js"), "utf8");
const kvJs = fs.readFileSync(path.join(root, "functions/_lib/kv.js"), "utf8");
const workerChat = fs.readFileSync(path.join(root, "functions/api/chat.js"), "utf8");
const dictJs = fs.readFileSync(path.join(root, "js/dictionary.js"), "utf8");

// thresholds and tiers
assert(/INSTANT:\s*0\.62/.test(chatJs), "chat instant threshold 0.62");
assert(/CONTEXT_FLOOR:\s*0\.46/.test(chatJs), "chat context floor 0.46");
assert(/PENDING_DAMP\s*=\s*0\.85/.test(dictJs), "pending entries damped 0.85");
assert(chatJs.includes('"./api/chat"'), "chat posts to /api/chat");
assert(chatJs.includes('"./api/resolve"'), "resolve posts to /api/resolve");
assert(chatUi.includes("AI researched") && chatUi.includes("Dictionary"), "both tier badges present");

// the whole point: images never short-circuit to the dictionary
assert(/if \(file\) \{\s*await answerWithWorker/.test(chatJs), "image messages always go to the worker");

// schema written to AGENT_KV
for (const field of ["section", "symptom", "tags", "diagnosis", "fix_steps"]) {
  assert(kvJs.includes(field), `kv writes ${field}`);
}
assert(kvJs.includes('source: "chat"'), "kv tags chat-created entries");
assert(kvJs.includes('status: "pending"'), "chat entries start pending");
assert(/expirationTtl:\s*THREAD_TTL/.test(kvJs), "threads expire");

// no-action guarantee
assert(/cannot change, enable, disable, refund/i.test(guardJs), "system prompt bans actions");
assert(guardJs.includes("claimsAction"), "output filter exists");
assert(workerChat.includes("claimsAction"), "worker applies the output filter");
assert(chatUi.includes("can't change anything in your store"), "ui states the limitation");
assert(html.includes("can't change anything in your store"), "chat header states the limitation");

// privacy + consent
assert(html.includes("This screenshot leaves your device"), "consent dialog copy");
assert(html.includes("Chat is the one exception"), "privacy panel updated");
assert(fs.readFileSync(path.join(root, "js/consent.js"), "utf8").includes("ss_img_consent"), "consent flag");

// service worker must not cache the API
assert(sw.includes('url.pathname.startsWith("/api/")'), "sw skips /api/");
assert(sw.includes("./js/chat.js"), "sw precaches chat");

// static-build degradation (GitHub Pages / offline zip have no Worker)
const chatSrc = fs.readFileSync(path.join(root, "js/chat.js"), "utf8");
assert(/runtime\.api === false/.test(chatSrc), "chat detects a static build");
assert(chatSrc.includes("answerFromScreenshotLocally"), "static build reads screenshots locally");
assert(/export const runtime/.test(fs.readFileSync(path.join(root, "js/dictionary.js"), "utf8")), "runtime flags exported");

// bindings
const wrangler = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
assert(/binding\s*=\s*"AGENT_KV"/.test(wrangler), "AGENT_KV binding declared");
assert(/\[ai\]/.test(wrangler), "Workers AI binding declared");
if (/REPLACE_WITH_/.test(wrangler)) warn.push("wrangler.toml still has placeholder KV namespace ids");

console.log(`OK ${ok.length}`);
if (warn.length) console.log("WARN\n" + warn.join("\n"));
if (fail.length) {
  console.log("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("All audit checks passed.");
console.log(`Dictionary entries: ${entries.length}`);
