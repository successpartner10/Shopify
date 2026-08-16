/**
 * POST /api/chat — the "AI researched" tier.
 *
 * Storescope has no Shopify OAuth and no Admin API. This endpoint DIAGNOSES ONLY.
 * Guardrails live in _lib/guard.js and are enforced on the way out, not just in the prompt.
 */

import {
  json, checkRate, getAllEntries, readThread, writeThread, hasKv
} from "../_lib/kv.js";
import { rank, detectScreen, normalizeEntry, shortHash } from "../_lib/match.js";
import {
  SYSTEM_PROMPT, extractJson, validateAnswer, claimsAction, DISCLAIMER
} from "../_lib/guard.js";

const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const MAX_BODY = 1_500_000;      // 1.5 MB
const LLM_TIMEOUT_MS = 12_000;
const HISTORY_TURNS = 8;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: "too_large", message: "That screenshot is too big. Try a smaller crop." }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const message = String(body.message || "").trim().slice(0, 2000);
  const image = body.image && body.image.b64 ? body.image : null;
  const ocrText = String(body.ocr_text || "").slice(0, 4000);
  const threadId = String(body.thread_id || "").slice(0, 40);
  const retry = Boolean(body.retry);

  if (!message && !image) return json({ error: "empty" }, 400);
  if (image) {
    const okMime = ["image/jpeg", "image/png", "image/webp"].includes(String(image.mime || "").toLowerCase());
    if (!okMime) return json({ error: "bad_image", message: "Attach a PNG, JPG, or WebP screenshot." }, 415);
  }

  const rate = await checkRate(env, request);
  if (!rate.ok) {
    return json({
      error: "rate_limited",
      message: "That's a lot of questions this hour. Dictionary answers still work — try again shortly."
    }, 429);
  }

  // ---- dictionary context (so the model builds on the playbook, not around it) ----
  const query = [message, ocrText].filter(Boolean).join("\n").slice(0, 4000);
  let allEntries = [];
  try {
    allEntries = await getAllEntries(env, request);
  } catch { /* context is optional */ }

  const screen = detectScreen(query);
  const ranked = rank(allEntries, query, { preferredCategory: screen.category, limit: 3 });
  const contextEntries = ranked.length
    ? ranked
    : (Array.isArray(body.context_entries) ? body.context_entries : [])
        .slice(0, 3)
        .map((e) => ({ entry: normalizeEntry(e), score: e.score || 0 }));

  // ---- conversation history ----
  const stored = await readThread(env, threadId);
  const clientHistory = Array.isArray(body.history) ? body.history : [];
  const history = (stored?.messages?.length ? stored.messages : clientHistory).slice(-HISTORY_TURNS);

  const userPrompt = buildUserPrompt({ message, ocrText, contextEntries, history, retry, hasImage: Boolean(image) });

  // ---- model call, with one repair retry ----
  let answer = null;
  let modelUsed = null;
  let lastError = null;

  for (let attempt = 0; attempt < 2 && !answer; attempt++) {
    const prompt = attempt === 0
      ? userPrompt
      : `${userPrompt}\n\nYour previous reply was rejected (${lastError}). Reply with ONLY the minified JSON object. Never claim you changed anything in the store.`;
    try {
      const { text, model } = await callModel(env, { prompt, image, timeoutMs: LLM_TIMEOUT_MS });
      modelUsed = model;
      const parsed = extractJson(text);
      const check = validateAnswer(parsed);
      if (check.ok) answer = check.value;
      else lastError = check.error;
    } catch (err) {
      lastError = String((err && err.message) || err);
      break; // network/timeout/no-binding: don't burn a second call
    }
  }

  const related = contextEntries.map((c) => c.entry.id).filter(Boolean);
  const messageId = `msg_${Date.now().toString(36)}${shortHash(query + String(Math.random()))}`;

  // ---- degrade: dictionary top hit, else generic local tips (never an error card) ----
  if (!answer) {
    const top = contextEntries[0];
    if (top && top.score >= 0.4) {
      const e = top.entry;
      await persist(env, threadId, history, message, e.diagnosis, "fallback", Boolean(image));
      return json({
        tier: "fallback",
        section: e.section,
        symptom: e.symptom,
        diagnosis: e.diagnosis,
        fix_steps: e.fix_steps,
        tags: e.tags,
        target_ui_hint: e.target_ui_hint,
        related,
        confidence: top.score,
        message_id: messageId,
        note: "The AI step didn't respond, so this is the closest playbook we already had.",
        disclaimer: DISCLAIMER,
        debug: { reason: lastError }
      });
    }
    const fb = genericFallback(screen.category);
    await persist(env, threadId, history, message, fb.diagnosis, "fallback", Boolean(image));
    return json({
      tier: "fallback",
      ...fb,
      related,
      confidence: 0.3,
      message_id: messageId,
      note: "The AI step didn't respond. These are the safest next checks.",
      disclaimer: DISCLAIMER,
      debug: { reason: lastError }
    });
  }

  // Belt and braces: the validator already checks, re-check the assembled prose.
  if (claimsAction([answer.symptom, answer.diagnosis, ...answer.fix_steps].join(" "))) {
    answer.diagnosis = answer.diagnosis.replace(/\b[Ii]'?ve\b/g, "You've");
  }

  await persist(env, threadId, history, message, answer.diagnosis, "ai", Boolean(image));

  return json({
    tier: "ai",
    ...answer,
    related,
    message_id: messageId,
    model: modelUsed,
    kv: hasKv(env),
    disclaimer: DISCLAIMER
  });
}

/* -------------------------------------------------------------------------- */

async function callModel(env, { prompt, image, timeoutMs }) {
  if (!env.AI || typeof env.AI.run !== "function") throw new Error("no AI binding");

  const model = image ? VISION_MODEL : TEXT_MODEL;
  const input = image
    ? {
        // Workers AI vision models take raw bytes, not a data URL.
        image: [...base64ToBytes(image.b64)],
        prompt: `${SYSTEM_PROMPT}\n\n${prompt}`,
        max_tokens: 900,
        temperature: 0.2
      }
    : {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        max_tokens: 900,
        temperature: 0.2
      };

  const run = env.AI.run(model, input);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("llm timeout")), timeoutMs)
  );
  const out = await Promise.race([run, timeout]);
  const text = typeof out === "string" ? out : (out?.response ?? out?.result ?? JSON.stringify(out));
  return { text, model };
}

function buildUserPrompt({ message, ocrText, contextEntries, history, retry, hasImage }) {
  const parts = [];

  if (contextEntries.length) {
    parts.push("EXISTING PLAYBOOK ENTRIES (build on these, do not present them as new):");
    for (const { entry, score } of contextEntries) {
      parts.push(
        `- [${entry.section}] ${entry.symptom} (match ${Math.round((score || 0) * 100)}%)\n` +
        `  why: ${String(entry.diagnosis || "").slice(0, 300)}\n` +
        `  steps: ${(entry.fix_steps || []).slice(0, 4).join(" | ").slice(0, 400)}`
      );
    }
  } else {
    parts.push("EXISTING PLAYBOOK ENTRIES: none matched. Write a fresh answer.");
  }

  if (history.length) {
    parts.push("\nCONVERSATION SO FAR (oldest first):");
    for (const m of history) {
      const who = m.role === "assistant" ? "Storescope" : "Merchant";
      parts.push(`${who}: ${String(m.text || "").slice(0, 400)}${m.had_image ? " [attached a screenshot]" : ""}`);
    }
  }

  if (ocrText) parts.push(`\nTEXT READ FROM THE MERCHANT'S SCREENSHOT:\n${ocrText.slice(0, 1500)}`);
  if (hasImage) parts.push("\nAn admin screenshot is attached. Read any banner, error, or highlighted field in it.");
  if (retry) parts.push("\nThe previous suggestion did NOT work. Do not repeat it — give a different, deeper cause.");

  parts.push(`\nMERCHANT'S MESSAGE:\n${message || "(no text — see the screenshot)"}`);
  parts.push("\nReply with ONLY the JSON object described in the system prompt.");
  return parts.join("\n");
}

async function persist(env, threadId, history, userText, assistantText, tier, hadImage) {
  if (!threadId) return;
  const messages = [
    ...history,
    { role: "user", text: userText, had_image: hadImage },
    { role: "assistant", text: assistantText, tier }
  ];
  await writeThread(env, threadId, messages);
}

function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]+,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function genericFallback(category) {
  const packs = {
    payments: {
      symptom: "Payment or payout issue",
      diagnosis: "We could not pin this to a specific playbook. Shopify almost always names a payment problem in a banner at the top of the admin, so start there and work down.",
      fix_steps: [
        "Read the yellow or red banner at the top of Shopify admin — it usually names the exact reason.",
        "Open Settings → Payments and confirm a provider shows as Active.",
        "Turn Test mode off and confirm live keys are saved, not sandbox keys.",
        "Check the store owner's email for a verification request from Shopify.",
        "Place a $1 test order in an incognito window, then refund it."
      ],
      target_ui_hint: "Settings → Payments"
    },
    shipping: {
      symptom: "Shipping or delivery issue",
      diagnosis: "We could not pin this to a specific playbook. Most shipping problems come down to a country sitting in the wrong zone, or a product with no weight.",
      fix_steps: [
        "Reproduce checkout with the customer's city, country, and postal code using a draft order.",
        "Open Settings → Shipping and delivery → Manage rates and confirm that country sits in exactly one zone with at least one rate.",
        "Add a fallback flat rate so a carrier API failure cannot zero out the methods.",
        "Confirm every physical product has a weight.",
        "Temporarily disable shipping apps and retest."
      ],
      target_ui_hint: "Settings → Shipping and delivery"
    },
    general: {
      symptom: "Shopify admin issue",
      diagnosis: "We could not pin this to a specific playbook. These are the safest general checks before changing anything.",
      fix_steps: [
        "Read the banner at the top of the admin — it is usually more specific than the page title.",
        "Note the exact page path (Settings → … or Online Store → …).",
        "Undo the last theme, app, or domain change if the issue started today.",
        "Retry in an incognito window as the store owner to rule out staff permissions and extensions.",
        "If the banner names an error, send us that exact phrase."
      ],
      target_ui_hint: "Admin home banner"
    }
  };
  const pack = packs[category] || packs.general;
  return { section: category || "general", tags: [category || "general", "fallback"], ...pack };
}
