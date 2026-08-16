/** GET /api/dictionary — seed + AGENT_KV entries, merged server-side. */

import { getAllEntries, json } from "../_lib/kv.js";
import { shortHash } from "../_lib/match.js";

export async function onRequestGet({ request, env }) {
  try {
    const entries = await getAllEntries(env, request);
    const payload = entries.map((e) => ({
      id: e.id,
      kv_key: e.kv_key || null,
      section: e.section,
      category: e.section,
      symptom: e.symptom,
      diagnosis: e.diagnosis,
      explanation: e.diagnosis,
      fix_steps: e.fix_steps,
      steps: e.fix_steps,
      tags: e.tags,
      synonyms: e.synonyms,
      match_phrases: e.match_phrases,
      target_ui_hint: e.target_ui_hint,
      arrow: e.arrow || { x: 0.5, y: 0.12 },
      source: e.source,
      status: e.status,
      hit_count: e.hit_count || 0
    }));

    const etag = `W/"${shortHash(JSON.stringify(payload.map((p) => [p.id, p.status, p.hit_count])))}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    return json({ entries: payload, count: payload.length }, 200, {
      etag,
      "cache-control": "public, max-age=60, stale-while-revalidate=600"
    });
  } catch (err) {
    // The client falls back to its static data/*.json files on any failure.
    return json({ entries: [], count: 0, error: String(err && err.message) }, 200);
  }
}
