/**
 * Guardrails: the model may only DIAGNOSE and ADVISE.
 * Storescope has no Shopify OAuth, no Admin API, no store access of any kind.
 * Layer 1 = system prompt. Layer 2 = the filters below. Layer 3 = UI copy.
 */

export const SYSTEM_PROMPT = `You are Storescope, a Shopify troubleshooting advisor.

HARD LIMITS — these are absolute:
- You have NO access to the merchant's Shopify store, account, admin, or API.
- You cannot change, enable, disable, refund, cancel, connect, configure, or fix anything.
- You never say "I've updated", "I've enabled", "I've fixed", "I've checked your store",
  "let me look at your account", or anything implying you acted on the store.
- You only describe what the MERCHANT should click, in their own Shopify admin.

STYLE:
- Plain language for a beginner. No jargon without a short explanation.
- Steps are imperative and specific: "Open Settings > Payments", "Tap Save".
- 3 to 6 steps. Each step is one action. Safest, most likely fix first.
- Never invent Shopify UI that does not exist. If unsure, tell them where to look
  and what to read, rather than guessing a menu path.
- If the answer needs Shopify Support or the merchant's bank, say so plainly.

CONTEXT RULES:
- You are given existing playbook entries. If one of them already answers the question,
  build on it and say so briefly — do NOT restate it as a brand new discovery.
- Use the conversation so far to resolve follow-ups like "still broken" or "what about UPS".

OUTPUT — return ONLY minified JSON, no prose, no markdown fences:
{"section":"payments|shipping|general","symptom":"short title, max 70 chars",
"diagnosis":"2-4 plain sentences on why this happens","fix_steps":["step 1","step 2","step 3"],
"tags":["3-6","lowercase","keywords"],"target_ui_hint":"Settings > Payments","confidence":0.0-1.0,
"screen_summary":"only when a screenshot was attached: one line naming the page and the visible problem, no personal data"}`;

const ACTION_CLAIM =
  /\b(?:i(?:'ve| have| had)?|we(?:'ve| have)?)\s+(?:just\s+|now\s+|already\s+)?(?:updated|changed|enabled|disabled|turned\s+(?:on|off)|fixed|refunded|cancelled|canceled|connected|configured|set(?:\s+up)?|added|removed|deleted|created|activated|deactivated|reset|adjusted|corrected|resolved)\b/i;

const ACCESS_CLAIM =
  /\b(?:i|we)\s+(?:can\s+see|looked\s+at|checked|accessed|logged\s+into|opened)\s+(?:your|the)\s+(?:store|admin|account|shop|dashboard|settings)\b/i;

const WILL_DO_CLAIM =
  /\b(?:i|we)\s*(?:['\u2019]ll|\s*will)\s+(?:go\s+ahead\s+and\s+)?(?:update|change|enable|disable|fix|refund|cancel|connect|configure|set|add|remove|turn)\b/i;

/** True when the text implies Storescope acted on (or can reach) the store. */
export function claimsAction(text) {
  const t = String(text || "");
  return ACTION_CLAIM.test(t) || ACCESS_CLAIM.test(t) || WILL_DO_CLAIM.test(t);
}

/** Strip anything that must never be written into a shared dictionary. */
export function scrub(text) {
  return String(text || "")
    .replace(/\bshp(?:at|ca|pa|ss)_[A-Za-z0-9]+/g, "[api-key-removed]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, "[api-key-removed]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, "[email-removed]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[number-removed]")
    .replace(/\b(?:\+?\d[\d ().-]{8,}\d)\b/g, "[number-removed]")
    .trim();
}

const SECTIONS = new Set(["payments", "shipping", "general"]);

/** Pull the first JSON object out of a model response that may include stray prose. */
export function extractJson(raw) {
  const text = String(raw || "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Validate + normalise a model answer.
 * Returns { ok, value } or { ok:false, error } so the caller can retry once.
 */
export function validateAnswer(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "not an object" };

  const section = SECTIONS.has(obj.section) ? obj.section : "general";
  const symptom = String(obj.symptom || "").trim().slice(0, 90);
  const diagnosis = String(obj.diagnosis || "").trim();
  const steps = Array.isArray(obj.fix_steps) ? obj.fix_steps : obj.steps;

  if (!symptom) return { ok: false, error: "missing symptom" };
  if (diagnosis.length < 20) return { ok: false, error: "diagnosis too short" };
  if (!Array.isArray(steps) || steps.length < 2) return { ok: false, error: "need 2+ fix_steps" };

  const fix_steps = steps
    .map((s) => String(s).replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (fix_steps.length < 2) return { ok: false, error: "need 2+ fix_steps" };

  const joined = [symptom, diagnosis, ...fix_steps].join(" ");
  if (claimsAction(joined)) return { ok: false, error: "implied an action on the store" };

  const tags = (Array.isArray(obj.tags) ? obj.tags : [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9 -]/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.6;

  const screenSummary = obj.screen_summary
    ? scrub(String(obj.screen_summary)).slice(0, 160)
    : null;

  return {
    ok: true,
    value: {
      section,
      symptom,
      diagnosis,
      fix_steps,
      ...(screenSummary ? { screen_summary: screenSummary } : {}),
      tags: tags.length ? tags : [section],
      target_ui_hint: String(obj.target_ui_hint || "Shopify admin").slice(0, 60),
      confidence: Number(confidence.toFixed(2))
    }
  };
}

export const DISCLAIMER =
  "Storescope can't change anything in your store — these are steps for you to click.";
