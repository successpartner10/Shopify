/** AGENT_KV access helpers. Key map per plan §3.2. */

import { normalizeEntry, rank, slugify, shortHash, compareFingerprints } from "./match.js";

export const INDEX_KEY = "index:issues";
export const REVIEW_KEY = "review:queue";
export const THREAD_TTL = 60 * 60 * 24 * 7; // 7 days
export const RATE_LIMIT = 30; // messages per hour per client

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });
}

export function hasKv(env) {
  return Boolean(env && env.AGENT_KV && typeof env.AGENT_KV.get === "function");
}

export async function getIndex(env) {
  if (!hasKv(env)) return [];
  try {
    return (await env.AGENT_KV.get(INDEX_KEY, "json")) || [];
  } catch {
    return [];
  }
}

export async function putIndex(env, index) {
  if (!hasKv(env)) return;
  await env.AGENT_KV.put(INDEX_KEY, JSON.stringify(index));
}

/** Every KV-stored issue entry, normalised. */
export async function getKvEntries(env, { includePending = true } = {}) {
  if (!hasKv(env)) return [];
  const index = await getIndex(env);
  const wanted = index.filter((row) => includePending || row.status === "published");
  const rows = await Promise.all(
    wanted.map(async (row) => {
      try {
        return await env.AGENT_KV.get(row.key, "json");
      } catch {
        return null;
      }
    })
  );
  return rows.filter(Boolean).map(normalizeEntry);
}

/** Seed dictionary, read straight off the Pages static assets. */
export async function getSeedEntries(env, request) {
  const base = new URL(request.url);
  const files = ["payments", "shipping", "general"];
  const out = [];
  await Promise.all(
    files.map(async (name) => {
      try {
        const url = new URL(`/data/${name}.json`, base);
        const res = env.ASSETS ? await env.ASSETS.fetch(new Request(url)) : await fetch(url);
        if (!res.ok) return;
        const rows = await res.json();
        for (const row of rows) out.push(normalizeEntry({ ...row, source: "seed", status: "published" }));
      } catch { /* seed file unavailable — KV entries still work */ }
    })
  );
  return out;
}

export async function getAllEntries(env, request) {
  const [seed, kv] = await Promise.all([getSeedEntries(env, request), getKvEntries(env)]);
  const byId = new Map();
  for (const e of seed) byId.set(e.id, e);
  for (const e of kv) byId.set(e.id, e); // KV overrides seed on id collision
  return [...byId.values()];
}

export function clientKey(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "anon";
  return shortHash(ip + "|" + (request.headers.get("user-agent") || ""));
}

/** Rolling hourly counter. Fails open if KV is missing. */
export async function checkRate(env, request) {
  if (!hasKv(env)) return { ok: true, remaining: RATE_LIMIT };
  const bucket = new Date().toISOString().slice(0, 13).replace(/[-T]/g, "");
  const key = `chat:rate:${clientKey(request)}:${bucket}`;
  let used = 0;
  try {
    used = Number((await env.AGENT_KV.get(key)) || 0);
  } catch { /* fail open */ }
  if (used >= RATE_LIMIT) return { ok: false, remaining: 0 };
  try {
    await env.AGENT_KV.put(key, String(used + 1), { expirationTtl: 3600 });
  } catch { /* fail open */ }
  return { ok: true, remaining: RATE_LIMIT - used - 1 };
}

export async function readThread(env, threadId) {
  if (!hasKv(env) || !threadId) return null;
  try {
    return await env.AGENT_KV.get(`chat:thread:${threadId}`, "json");
  } catch {
    return null;
  }
}

export async function writeThread(env, threadId, messages) {
  if (!hasKv(env) || !threadId) return;
  const trimmed = messages.slice(-20).map((m) => ({
    role: m.role,
    text: String(m.text || "").slice(0, 1200),
    tier: m.tier || null,
    had_image: Boolean(m.had_image)
  }));
  try {
    await env.AGENT_KV.put(
      `chat:thread:${threadId}`,
      JSON.stringify({ messages: trimmed, updated_at: new Date().toISOString() }),
      { expirationTtl: THREAD_TTL }
    );
  } catch { /* context is best-effort */ }
}

/**
 * Save a confirmed fix. Dedupes: ≥0.75 against an existing entry merges the
 * merchant's phrasing into it instead of creating a near-duplicate (plan §2.3).
 */
export async function saveIssue(env, request, answer, meta = {}) {
  if (!hasKv(env)) return { saved: false, reason: "no-kv" };

  const now = new Date().toISOString();
  const existing = await getAllEntries(env, request);
  const hits = rank(existing, answer.symptom + " " + (meta.question || ""), {
    preferredCategory: answer.section,
    limit: 1
  });
  const top = hits[0];

  // --- merge path -------------------------------------------------------
  if (top && top.score >= 0.75) {
    const target = top.entry;
    if (target.source === "seed" || !target.kv_key) {
      // Never rewrite a shipped seed file; record the phrasing as an override entry.
      const key = `issue:${target.section}:${slugify(target.symptom)}-${shortHash(target.id)}`;
      const merged = {
        ...target,
        kv_key: key,
        id: target.id,
        source: target.source === "seed" ? "seed+chat" : target.source,
        status: "published",
        synonyms: dedupe([...(target.synonyms || []), meta.question].filter(Boolean)).slice(0, 40),
        fingerprints: addFingerprint(target.fingerprints, meta.fingerprint),
        screen_summary: target.screen_summary || meta.screen_summary || null,
        hit_count: (target.hit_count || 0) + 1,
        updated_at: now,
        thread_ref: meta.thread_id || null
      };
      await env.AGENT_KV.put(key, JSON.stringify(mirror(merged)));
      await upsertIndex(env, merged, key);
      return { saved: true, key, mode: "merged" };
    }
    const merged = {
      ...target,
      synonyms: dedupe([...(target.synonyms || []), meta.question].filter(Boolean)).slice(0, 40),
      fingerprints: addFingerprint(target.fingerprints, meta.fingerprint),
      screen_summary: target.screen_summary || meta.screen_summary || null,
      hit_count: (target.hit_count || 0) + 1,
      updated_at: now
    };
    // 3 independent confirmations promote a pending entry (plan §3.3)
    if (merged.status === "pending" && merged.hit_count >= 3) merged.status = "published";
    await env.AGENT_KV.put(target.kv_key, JSON.stringify(mirror(merged)));
    await upsertIndex(env, merged, target.kv_key);
    return { saved: true, key: target.kv_key, mode: "merged", status: merged.status };
  }

  // --- create path ------------------------------------------------------
  const slug = `${slugify(answer.symptom)}-${shortHash(answer.symptom + now)}`;
  const key = `issue:${answer.section}:${slug}`;
  const entry = mirror({
    id: `chat-${answer.section}-${shortHash(slug)}`,
    kv_key: key,
    section: answer.section,
    symptom: answer.symptom,
    tags: answer.tags,
    diagnosis: answer.diagnosis,
    fix_steps: answer.fix_steps,
    match_phrases: dedupe([answer.symptom.toLowerCase(), ...(meta.question ? [meta.question.toLowerCase().slice(0, 120)] : [])]),
    synonyms: meta.question ? [meta.question.slice(0, 120)] : [],
    target_ui_hint: answer.target_ui_hint,
    arrow: { x: 0.5, y: 0.12 },
    fingerprints: addFingerprint([], meta.fingerprint),
    screen_summary: meta.screen_summary || null,
    source: "chat",
    status: "pending",
    created_at: now,
    updated_at: now,
    hit_count: 1,
    thread_ref: meta.thread_id || null,
    had_image: Boolean(meta.had_image),
    model: meta.model || null
  });

  await env.AGENT_KV.put(key, JSON.stringify(entry));
  await upsertIndex(env, entry, key);
  try {
    const queue = (await env.AGENT_KV.get(REVIEW_KEY, "json")) || [];
    if (!queue.includes(key)) {
      queue.unshift(key);
      await env.AGENT_KV.put(REVIEW_KEY, JSON.stringify(queue.slice(0, 500)));
    }
  } catch { /* queue is advisory */ }

  return { saved: true, key, mode: "created", status: "pending" };
}

/** Write your schema and the client-compat mirror together, once, server-side. */
export function mirror(entry) {
  return {
    ...entry,
    category: entry.section,
    explanation: entry.diagnosis,
    steps: entry.fix_steps
  };
}

async function upsertIndex(env, entry, key) {
  const index = await getIndex(env);
  const row = {
    id: entry.id,
    key,
    section: entry.section,
    symptom: entry.symptom,
    tags: entry.tags || [],
    status: entry.status || "pending",
    hit_count: entry.hit_count || 0,
    updated_at: entry.updated_at
  };
  const i = index.findIndex((r) => r.key === key || r.id === entry.id);
  if (i === -1) index.unshift(row);
  else index[i] = row;
  await putIndex(env, index);
}

const MAX_FINGERPRINTS = 8;

/**
 * Add a screen fingerprint to an entry, unless we already have a near-identical
 * one. 8 bytes each, capped at 8 per entry — no image data, no PII.
 */
function addFingerprint(existing = [], fp, meta = {}) {
  if (!fp || !fp.dhash) return existing;
  for (const stored of existing) {
    if (compareFingerprints(fp, stored) >= 0.9) return existing; // already know this screen
  }
  const row = {
    v: fp.v || 1,
    dhash: String(fp.dhash).slice(0, 32),
    tiles: (fp.tiles || []).slice(0, 4).map((x) => String(x).slice(0, 32)),
    added: new Date().toISOString().slice(0, 10),
    source: meta.source || "chat"
  };
  return [...existing, row].slice(-MAX_FINGERPRINTS);
}

function dedupe(list) {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}
