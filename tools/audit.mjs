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
  "js/capture.js", "js/samples.js", "js/vendor/fuse.min.js",
  "data/payments.json", "data/shipping.json", "data/general.json",
  "samples/payout-hold.svg", "samples/no-shipping.svg", "samples/no-provider.svg",
  "samples/theme-errors.svg", "icons/favicon.svg", "icons/icon-192.png", "icons/icon-512.png"
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

console.log(`OK ${ok.length}`);
if (warn.length) console.log("WARN\n" + warn.join("\n"));
if (fail.length) {
  console.log("FAIL\n" + fail.join("\n"));
  process.exit(1);
}
console.log("All audit checks passed.");
console.log(`Dictionary entries: ${entries.length}`);
