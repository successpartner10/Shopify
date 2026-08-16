/**
 * Shared matcher — server-side twin of js/dictionary.js.
 * Deliberately dependency-free (no Fuse) so it runs inside a Worker.
 * Understands BOTH entry shapes:
 *   seed  : { id, category, match_phrases, synonyms, tags, explanation, steps }
 *   AGENT_KV : { id, section, symptom, tags, diagnosis, fix_steps, ... }
 */

const CATEGORY_ORDER = ["payments", "shipping", "general"];

const SCREEN_HINTS = {
  payments: [
    "payout", "payment", "shopify payments", "paypal", "shop pay", "chargeback",
    "dispute", "bank account", "capture payment", "credit card", "gateway", "3d secure"
  ],
  shipping: [
    "shipping", "delivery", "carrier", "fulfill", "zone", "shipping rate",
    "local pickup", "package", "label", "usps", "ups", "fedex"
  ],
  general: [
    "domain", "theme", "liquid", "tax", "markets", "pixel", "gift card",
    "password", "notification", "inventory", "staff"
  ]
};

export function detectScreen(text) {
  const hay = (text || "").toLowerCase();
  let best = { category: "general", score: 0 };
  for (const [category, words] of Object.entries(SCREEN_HINTS)) {
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length > 8 ? 2 : 1;
    if (score > best.score) best = { category, score };
  }
  return best;
}

/** Normalise either shape into one object with both field families present. */
export function normalizeEntry(raw) {
  if (!raw) return null;
  const section = raw.section || raw.category || "general";
  const symptom = raw.symptom || raw.target_ui_hint || (raw.match_phrases || [])[0] || "Issue";
  const diagnosis = raw.diagnosis || raw.explanation || "";
  const fix_steps = raw.fix_steps || raw.steps || [];
  return {
    ...raw,
    id: raw.id,
    section,
    category: section,
    symptom,
    target_ui_hint: raw.target_ui_hint || symptom,
    diagnosis,
    explanation: diagnosis,
    fix_steps,
    steps: fix_steps,
    tags: raw.tags || [],
    synonyms: raw.synonyms || [],
    match_phrases: raw.match_phrases || [],
    fingerprints: raw.fingerprints || [],
    status: raw.status || "published",
    source: raw.source || "seed"
  };
}

function phraseHits(entry, hay) {
  const fields = [
    ...(entry.match_phrases || []),
    ...(entry.synonyms || []),
    entry.symptom || ""
  ];
  let hits = 0;
  let longest = 0;
  for (const phrase of fields) {
    const p = String(phrase).toLowerCase();
    if (p.length >= 4 && hay.includes(p)) {
      hits += 1;
      longest = Math.max(longest, p.length);
    }
  }
  for (const tag of entry.tags || []) {
    if (hay.includes(String(tag).toLowerCase())) hits += 0.35;
  }
  return { hits, longest };
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "not", "but", "was", "are",
  "have", "has", "why", "how", "what", "when", "cant", "can", "does", "did", "will", "from",
  "into", "still", "just", "get", "got", "any", "all", "its", "shopify", "store", "help"
]);

function tokens(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s>$/-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Cheap fuzzy stand-in for Fuse: weighted token overlap. */
function overlapScore(entry, qTokens) {
  if (!qTokens.length) return 0;
  const hay = new Set(
    tokens(
      [
        (entry.match_phrases || []).join(" "),
        (entry.synonyms || []).join(" "),
        (entry.tags || []).join(" "),
        entry.symptom,
        entry.diagnosis
      ].join(" ")
    )
  );
  let hit = 0;
  for (const t of qTokens) if (hay.has(t)) hit += 1;
  return hit / qTokens.length;
}

/**
 * Rank entries against a query.
 * Returns [{ entry, score }] sorted desc. `pending` entries are damped ×0.85
 * so a reviewed playbook always wins a tie (plan §3.3).
 */
export function rank(entries, query, opts = {}) {
  const q = (query || "").trim();
  if (!q) return [];
  const hay = q.toLowerCase();
  const qTokens = tokens(q);
  const preferred = opts.preferredCategory || detectScreen(q).category;
  const out = [];

  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    if (!entry || entry.status === "rejected") continue;

    const { hits, longest } = phraseHits(entry, hay);
    let score = 0;
    if (hits > 0) {
      const catBoost = entry.section === preferred ? 0.15 : 0;
      const priBoost = (3 - CATEGORY_ORDER.indexOf(entry.section)) * 0.02;
      score = Math.min(0.99, 0.35 + hits * 0.12 + longest / 80 + catBoost + priBoost);
    }
    const overlap = overlapScore(entry, qTokens);
    if (overlap > 0) {
      const fuzzy = Math.min(0.9, overlap * 0.8 + (entry.section === preferred ? 0.08 : 0));
      score = Math.max(score, fuzzy);
    }
    if (score <= 0) continue;
    if (entry.status === "pending") score *= 0.85;
    out.push({ entry, score: Number(score.toFixed(3)) });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, opts.limit || 8);
}

/* ---------------------------- screen fingerprints -------------------------- */

const HEX_BITS = { 0:0,1:1,2:1,3:2,4:1,5:2,6:2,7:3,8:1,9:2,a:2,b:3,c:2,d:3,e:3,f:4 };

export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    d += HEX_BITS[x.toString(16)] ?? 4;
  }
  return d;
}

/** Mirror of compareFingerprints() in js/fingerprint.js — keep the two in step. */
export function compareFingerprints(a, b) {
  if (!a || !b || !a.dhash || !b.dhash) return 0;
  const d = hamming(a.dhash, b.dhash);
  const tileHits = (a.tiles || []).reduce((n, t, i) => n + (hamming(t, (b.tiles || [])[i]) <= 10 ? 1 : 0), 0);
  let score = 0;
  if (d <= 6) score = 0.9;
  else if (d <= 10) score = 0.75;
  else if (d <= 14) score = 0.6;
  else if (d <= 18 && tileHits >= 3) score = 0.55;
  else return 0;
  if (tileHits >= 3) score += 0.05;
  else if (tileHits <= 1) score -= 0.15;
  return Math.max(0, Math.min(0.95, Number(score.toFixed(3))));
}

/** Entries whose stored fingerprints look like the same admin screen. */
export function rankByFingerprint(entries, fp, limit = 3) {
  if (!fp) return [];
  const out = [];
  for (const raw of entries) {
    const entry = normalizeEntry(raw);
    let best = 0;
    for (const stored of entry.fingerprints || []) {
      const s = compareFingerprints(fp, stored);
      if (s > best) best = s;
    }
    if (best > 0) out.push({ entry, score: entry.status === "pending" ? best * 0.85 : best, via: "screen" });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export function slugify(text, words = 6) {
  return (text || "issue")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, words)
    .join("-")
    .slice(0, 60) || "issue";
}

export function shortHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, "0");
}
