/**
 * POST /api/resolve — merchant tapped "This fixed it".
 * Saves the exchange into AGENT_KV using the existing schema
 * (section, symptom, tags, diagnosis, fix_steps) tagged source:"chat".
 */

import { json, saveIssue, hasKv, checkRate } from "../_lib/kv.js";
import { scrub, validateAnswer, claimsAction } from "../_lib/guard.js";

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ saved: false, error: "bad_json" }, 400);
  }

  const rate = await checkRate(env, request);
  if (!rate.ok) return json({ saved: false, error: "rate_limited" }, 429);

  if (!hasKv(env)) {
    // Chat still works; we just can't grow the playbook without the binding.
    return json({ saved: false, reason: "no-kv", message: "Saved on this device only." }, 200);
  }

  const question = scrub(String(body.question || "").slice(0, 500));
  const candidate = {
    section: body.section,
    symptom: scrub(String(body.symptom || question).slice(0, 90)),
    diagnosis: scrub(String(body.diagnosis || "")),
    fix_steps: (Array.isArray(body.fix_steps) ? body.fix_steps : []).map((s) => scrub(s)),
    tags: Array.isArray(body.tags) ? body.tags : [],
    target_ui_hint: body.target_ui_hint,
    confidence: body.confidence
  };

  const check = validateAnswer(candidate);
  if (!check.ok) return json({ saved: false, error: "invalid", detail: check.error }, 422);
  if (claimsAction([check.value.diagnosis, ...check.value.fix_steps].join(" "))) {
    return json({ saved: false, error: "guard", detail: "answer implied an action on the store" }, 422);
  }

  try {
    const result = await saveIssue(env, request, check.value, {
      question,
      thread_id: String(body.thread_id || "").slice(0, 40),
      had_image: Boolean(body.had_image),
      model: body.model || null
    });
    return json({
      ...result,
      message: result.mode === "merged"
        ? "Added your wording to an existing playbook entry."
        : "Saved to the playbook for review."
    });
  } catch (err) {
    return json({ saved: false, error: "kv_write_failed", detail: String(err && err.message) }, 500);
  }
}
