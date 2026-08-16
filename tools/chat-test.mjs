/**
 * Worker logic tests — no wrangler, no network.
 * Fakes AGENT_KV, env.ASSETS and env.AI, then drives the real endpoint modules.
 *   node tools/chat-test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pass = [];
const fail = [];
const t = (name, cond) => (cond ? pass : fail).push(name);

const { rank, normalizeEntry } = await import(path.join(root, "functions/_lib/match.js"));
const { validateAnswer, claimsAction, extractJson, scrub } = await import(path.join(root, "functions/_lib/guard.js"));
const { onRequestPost: chatPost } = await import(path.join(root, "functions/api/chat.js"));
const { onRequestPost: resolvePost } = await import(path.join(root, "functions/api/resolve.js"));
const { onRequestGet: dictGet } = await import(path.join(root, "functions/api/dictionary.js"));

/* ------------------------------- fake env -------------------------------- */

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); }
  };
}

function fakeAssets() {
  return {
    async fetch(req) {
      const url = new URL(typeof req === "string" ? req : req.url);
      const file = path.join(root, url.pathname.replace(/^\//, ""));
      if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(fs.readFileSync(file, "utf8"), { status: 200 });
    }
  };
}

function env({ ai, kv = fakeKv() } = {}) {
  return { AGENT_KV: kv, ASSETS: fakeAssets(), AI: ai ? { run: ai } : undefined };
}

const post = (body) =>
  new Request("https://storescope-cwl.pages.dev/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body)
  });

const goodAnswer = {
  section: "payments",
  symptom: "Payout held pending identity verification",
  diagnosis: "Shopify holds transfers when identity documents are outstanding. Orders still process, but the bank transfer waits until the review clears.",
  fix_steps: [
    "Open Settings then Payments in your Shopify admin.",
    "Look for a banner asking for identity documents and tap Verify.",
    "Upload a government ID that matches the account owner name.",
    "Check the owner email for a confirmation within 3 business days."
  ],
  tags: ["payout", "hold", "verification"],
  target_ui_hint: "Settings > Payments",
  confidence: 0.78
};

/* -------------------------------- matcher -------------------------------- */

const seed = JSON.parse(fs.readFileSync(path.join(root, "data/payments.json"), "utf8"));
const ranked = rank(seed, "your payouts are temporarily on hold");
t("matcher finds the payout entry", ranked[0]?.entry.id === "payments-payout-hold-001");
t("matcher scores it confidently", ranked[0]?.score >= 0.62);

const pendingEntry = normalizeEntry({ ...seed[0], id: "x-pending", status: "pending" });
const dampScore = rank([pendingEntry], "your payouts are temporarily on hold")[0].score;
const liveScore = rank([normalizeEntry(seed[0])], "your payouts are temporarily on hold")[0].score;
t("pending entries are damped below published", dampScore < liveScore);

t("normalizeEntry bridges both schemas", (() => {
  const n = normalizeEntry({ id: "a", section: "shipping", symptom: "S", diagnosis: "D", fix_steps: ["1", "2"] });
  return n.category === "shipping" && n.explanation === "D" && n.steps.length === 2;
})());

/* -------------------------------- guards --------------------------------- */

t("guard blocks 'I've updated'", claimsAction("I've updated your payment settings."));
t("guard blocks 'I checked your store'", claimsAction("I checked your store and the gateway is off."));
t("guard blocks \"I'll enable it\"", claimsAction("I'll enable Shopify Payments for you."));
t("guard allows merchant-directed steps", !claimsAction("Open Settings then Payments and tap Verify."));
t("guard allows past tense about the merchant", !claimsAction("You updated the theme yesterday, which can cause this."));

t("validator rejects an action claim", validateAnswer({ ...goodAnswer, diagnosis: "I have enabled Shopify Payments for you so this is now resolved." }).ok === false);
t("validator accepts a clean answer", validateAnswer(goodAnswer).ok === true);
t("validator rejects 1-step answers", validateAnswer({ ...goodAnswer, fix_steps: ["Only one"] }).ok === false);
t("validator strips step numbering", validateAnswer({ ...goodAnswer, fix_steps: ["1. Open Settings", "2. Tap Verify"] }).value.fix_steps[0] === "Open Settings");

t("extractJson survives chatty models", extractJson('Sure! Here you go:\n```json\n{"a":{"b":1}}\n```\nHope that helps')?.a.b === 1);
t("scrub removes api keys", scrub("key shpat_abc123def456").includes("[api-key-removed]"));
t("scrub removes emails", scrub("mail me at owner@shop.com").includes("[email-removed]"));

/* ------------------------------ /api/chat -------------------------------- */

{
  const ai = async () => ({ response: JSON.stringify(goodAnswer) });
  const res = await chatPost({ request: post({ thread_id: "th_1", message: "payouts on hold for 5 days" }), env: env({ ai }) });
  const body = await res.json();
  t("chat returns the AI tier", body.tier === "ai");
  t("chat returns fix_steps", Array.isArray(body.fix_steps) && body.fix_steps.length >= 2);
  t("chat always ships the disclaimer", /can't change anything in your store/.test(body.disclaimer));
  t("chat passes dictionary context as related", Array.isArray(body.related) && body.related.length > 0);
}

{
  // Model claims an action on the first try, behaves on the repair retry.
  let call = 0;
  const ai = async () => {
    call++;
    return { response: call === 1
      ? JSON.stringify({ ...goodAnswer, diagnosis: "I have already updated your payout settings, so you are all set now." })
      : JSON.stringify(goodAnswer) };
  };
  const res = await chatPost({ request: post({ message: "payout stuck" }), env: env({ ai }) });
  const body = await res.json();
  t("guard triggers exactly one repair retry", call === 2);
  t("repaired answer is served as AI tier", body.tier === "ai");
  t("no action claim survives to the client", !claimsAction([body.diagnosis, ...body.fix_steps].join(" ")));
}

{
  // Model keeps misbehaving -> must degrade to a dictionary answer, never an error.
  const ai = async () => ({ response: "I've refunded the order for you." });
  const res = await chatPost({ request: post({ message: "your payouts are temporarily on hold" }), env: env({ ai }) });
  const body = await res.json();
  t("bad model degrades to fallback tier", body.tier === "fallback");
  t("fallback still returns usable steps", body.fix_steps.length >= 3);
  t("fallback never claims an action", !claimsAction([body.diagnosis, ...body.fix_steps].join(" ")));
}

{
  // No AI binding at all (quota exhausted / not configured yet).
  const res = await chatPost({ request: post({ message: "no shipping rates at checkout" }), env: env({}) });
  const body = await res.json();
  t("missing AI binding still answers", res.status === 200 && body.fix_steps.length >= 3);
  t("missing AI binding is tagged fallback", body.tier === "fallback");
}

{
  // Vision path: image must reach the vision model as bytes.
  let seenModel = null;
  let seenInput = null;
  const ai = async (model, input) => { seenModel = model; seenInput = input; return { response: JSON.stringify(goodAnswer) }; };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ).toString("base64");
  const res = await chatPost({
    request: post({ message: "what is this banner", image: { mime: "image/png", b64: png }, ocr_text: "Payouts are temporarily on hold" }),
    env: env({ ai })
  });
  const body = await res.json();
  t("image routes to the vision model", seenModel === "@cf/meta/llama-3.2-11b-vision-instruct");
  t("image is sent as a byte array", Array.isArray(seenInput.image) && seenInput.image.length > 0);
  t("vision answer returns normally", body.tier === "ai");
}

{
  const badMime = await chatPost({ request: post({ message: "hi", image: { mime: "image/gif", b64: "AAA" } }), env: env({}) });
  t("unsupported image type is rejected", badMime.status === 415);
}

{
  // Rate limit: 30/hr per client.
  const kv = fakeKv();
  const ai = async () => ({ response: JSON.stringify(goodAnswer) });
  let limited = null;
  for (let i = 0; i < 32; i++) {
    const r = await chatPost({ request: post({ message: `question ${i}` }), env: env({ ai, kv }) });
    if (r.status === 429) { limited = i; break; }
  }
  t("rate limit kicks in at 30", limited === 30);
}

/* ----------------------------- /api/resolve ------------------------------ */

// A problem that is genuinely NOT in the seed dictionary, so it must create.
const novelAnswer = {
  section: "general",
  symptom: "Checkout page blank after installing a currency converter app",
  diagnosis: "A recently installed app injected a script that breaks the checkout render on mobile browsers. The store itself is fine; the app script is the blocker.",
  fix_steps: [
    "Open Apps in your Shopify admin and note anything installed in the last week.",
    "Pause the newest app and load checkout again in a private window.",
    "If checkout returns, contact that app's support with the date it started.",
    "Re-enable apps one at a time to confirm which one causes it."
  ],
  tags: ["checkout", "apps", "blank page"],
  target_ui_hint: "Apps",
  confidence: 0.7
};

{
  // Sanity: the novel symptom must NOT be a near-duplicate of anything seeded.
  const all = ["payments", "shipping", "general"].flatMap((f) =>
    JSON.parse(fs.readFileSync(path.join(root, `data/${f}.json`), "utf8")));
  const top = rank(all, novelAnswer.symptom, { preferredCategory: "general", limit: 1 })[0];
  t("novel symptom is below the dedupe bar", !top || top.score < 0.75);

  // And a known symptom must be caught as a duplicate.
  const dupe = rank(all, "Payout held pending identity verification", { preferredCategory: "payments", limit: 1 })[0];
  t("known symptom is caught as a duplicate", dupe && dupe.score >= 0.75);
}

{
  const kv = fakeKv();
  const e = env({ kv });
  const req = new Request("https://x/api/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ thread_id: "th_1", question: "checkout is blank, email me at owner@shop.com", ...novelAnswer })
  });
  const res = await resolvePost({ request: req, env: e });
  const body = await res.json();
  t("resolve saves a new entry", body.saved === true && body.mode === "created");

  const stored = JSON.parse(kv.store.get(body.key));
  t("entry uses the AGENT_KV schema", ["section", "symptom", "tags", "diagnosis", "fix_steps"].every((k) => k in stored));
  t("entry carries compat mirrors", stored.category === stored.section && stored.explanation === stored.diagnosis && stored.steps.length === stored.fix_steps.length);
  t('entry is tagged source "chat"', stored.source === "chat");
  t("entry starts pending", stored.status === "pending");
  t("pii is scrubbed from the saved phrasing", !JSON.stringify(stored).includes("owner@shop.com"));
  t("index row written", JSON.parse(kv.store.get("index:issues")).length === 1);
  t("review queue populated", JSON.parse(kv.store.get("review:queue")).includes(body.key));

  // Same fix confirmed twice more -> merge, then auto-promote at 3.
  let last;
  for (let i = 0; i < 2; i++) {
    const r = await resolvePost({
      request: new Request("https://x/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ question: "blank checkout after new app", ...novelAnswer })
      }),
      env: e
    });
    last = await r.json();
  }
  t("duplicate confirmations merge, not duplicate", last.mode === "merged");
  t("index still has one row", JSON.parse(kv.store.get("index:issues")).length === 1);
  const promoted = JSON.parse(kv.store.get(body.key));
  t("auto-promotes to published after 3", promoted.status === "published" && promoted.hit_count >= 3);
}

{
  const kv = fakeKv();
  const res = await resolvePost({
    request: new Request("https://x/api/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodAnswer, diagnosis: "I have connected your bank account and the payout is released." })
    }),
    env: env({ kv })
  });
  t("resolve refuses to save an action claim", res.status === 422);
  t("nothing was written to KV", kv.store.size === 0 || !JSON.stringify([...kv.store.keys()]).includes("issue:"));
}

{
  // Confirming a fix that already exists must NOT create a second entry.
  const kv = fakeKv();
  const e = env({ kv });
  const res = await resolvePost({
    request: new Request("https://x/api/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "my payouts are on hold for identity checks", ...goodAnswer })
    }),
    env: e
  });
  const body = await res.json();
  t("duplicate of a seed entry merges instead of creating", body.mode === "merged");
  const stored = JSON.parse(kv.store.get(body.key));
  t("seed merge keeps the original id", stored.id === "payments-identity-verification-006");
  t("seed merge records the merchant phrasing", stored.synonyms.some((x) => /identity checks/.test(x)));
  t("seed merge is not queued for review", !kv.store.has("review:queue"));
}

/* ---------------------------- /api/dictionary ---------------------------- */

{
  const kv = fakeKv();
  const e = env({ kv });
  await resolvePost({
    request: new Request("https://x/api/resolve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "brand new problem", ...novelAnswer })
    }),
    env: e
  });
  const res = await dictGet({ request: new Request("https://storescope-cwl.pages.dev/api/dictionary"), env: e });
  const body = await res.json();
  t("dictionary merges seed + kv", body.count >= 49);
  t("dictionary exposes status for filtering", body.entries.every((x) => "status" in x));
  t("dictionary serves both schemas", body.entries.every((x) => x.section && x.category && x.fix_steps && x.steps));
}

{
  // No KV binding anywhere: everything must still respond 200.
  const res = await dictGet({ request: new Request("https://x/api/dictionary"), env: { ASSETS: fakeAssets() } });
  const body = await res.json();
  t("dictionary works without KV", res.status === 200 && body.count >= 48);
  const r2 = await resolvePost({
    request: new Request("https://x/api/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodAnswer) }),
    env: { ASSETS: fakeAssets() }
  });
  t("resolve degrades politely without KV", r2.status === 200 && (await r2.json()).reason === "no-kv");
}

/* --------------------------------- report -------------------------------- */

console.log(`\nPASS ${pass.length}`);
if (fail.length) {
  console.log("\nFAIL:");
  for (const f of fail) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("All chat worker tests passed.\n");
