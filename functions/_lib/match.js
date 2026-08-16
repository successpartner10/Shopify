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
