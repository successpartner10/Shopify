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

export function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s>$/-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Normalise either entry shape into one object carrying both field families:
 *   seed : { category, match_phrases, synonyms, explanation, steps }
 *   AGENT_KV : { section, symptom, diagnosis, fix_steps }
 * Written once here so no other client code needs to translate fields.
 */
export function normalizeEntry(raw) {
  if (!raw) return null;
  const section = raw.section || raw.category || "general";
  const diagnosis = raw.diagnosis || raw.explanation || "";
  const steps = raw.fix_steps || raw.steps || [];
  const symptom = raw.symptom || raw.target_ui_hint || (raw.match_phrases || [])[0] || "Issue";
  return {
    ...raw,
    section,
    category: section,
    symptom,
    target_ui_hint: raw.target_ui_hint || symptom,
    diagnosis,
    explanation: diagnosis,
    fix_steps: steps,
    steps,
    tags: raw.tags || [],
    synonyms: raw.synonyms || [],
    match_phrases: raw.match_phrases || [],
    arrow: raw.arrow || { x: 0.5, y: 0.12 },
    status: raw.status || "published",
    source: raw.source || "seed"
  };
}

/**
 * Runtime capability flags. `api` is null until we've probed once:
 *   true  -> Cloudflare Pages build, Worker endpoints exist (full AI chat)
 *   false -> static build (GitHub Pages / offline zip), dictionary answers only
 */
export const runtime = { api: null, kvCount: 0 };

/** Static seed files only — always available, works offline. */
async function loadSeed() {
  const files = ["payments", "shipping", "general"];
  const entries = [];
  const errors = [];
  await Promise.all(
    files.map(async (name) => {
      try {
        const res = await fetch(`./data/${name}.json`, { cache: "force-cache" });
        if (!res.ok) throw new Error(`${name} ${res.status}`);
        const data = await res.json();
        for (const row of data) entries.push(normalizeEntry(row));
      } catch (err) {
        errors.push(String(err));
      }
    })
  );
  return { entries, errors };
}

/**
 * Seed files first, then AGENT_KV entries layered on top by id.
 * The KV fetch is best-effort: offline or a missing Worker just means seed-only,
 * so the Tap / Voice / Screenshot flows are never blocked by it.
 */
export async function loadDictionaries({ withKv = true } = {}) {
  const { entries, errors } = await loadSeed();
  if (!withKv || !navigator.onLine) return { entries, errors, kvCount: 0 };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("./api/dictionary", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`dictionary ${res.status}`);
    const data = await res.json();
    runtime.api = true;
    const kvRows = Array.isArray(data.entries) ? data.entries : [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const row of kvRows) {
      const entry = normalizeEntry(row);
      if (entry && entry.id && entry.status !== "rejected") byId.set(entry.id, entry);
    }
    runtime.kvCount = kvRows.length;
    return { entries: [...byId.values()], errors, kvCount: kvRows.length };
  } catch (err) {
    // 404 / HTML / parse error all mean the same thing: no Worker behind this build.
    runtime.api = false;
    errors.push(`kv: ${String(err && err.message ? err.message : err)}`);
    return { entries, errors, kvCount: 0 };
  }
}

export function buildIndex(entries) {
  if (!window.Fuse) throw new Error("Fuse.js failed to load");
  return new window.Fuse(entries, {
    includeScore: true,
    threshold: 0.46,
    ignoreLocation: true,
    minMatchCharLength: 3,
    keys: [
      { name: "match_phrases", weight: 0.45 },
      { name: "synonyms", weight: 0.25 },
      { name: "tags", weight: 0.15 },
      { name: "explanation", weight: 0.1 },
      { name: "target_ui_hint", weight: 0.05 }
    ]
  });
}

/**
 * Unreviewed chat-created entries are searchable but damped, so a curated
 * playbook always wins a tie (plan §3.3).
 */
export const PENDING_DAMP = 0.85;
function dampPending(entry, score) {
  return entry && entry.status === "pending" ? score * PENDING_DAMP : score;
}

function phraseHits(entry, hay) {
  const fields = [...(entry.match_phrases || []), ...(entry.synonyms || [])];
  let hits = 0;
  let longest = 0;
  for (const phrase of fields) {
    const p = phrase.toLowerCase();
    if (p.length >= 4 && hay.includes(p)) {
      hits += 1;
      longest = Math.max(longest, p.length);
    }
  }
  for (const tag of entry.tags || []) {
    if (hay.includes(tag.toLowerCase())) hits += 0.35;
  }
  return { hits, longest };
}

export function searchDictionary(entries, fuse, query, opts = {}) {
  const q = (query || "").trim();
  if (!q) return { match: null, alternatives: [], source: "empty", confidence: 0 };

  const hay = q.toLowerCase();
  const preferred = opts.preferredCategory || detectScreen(q).category;

  const exact = [];
  for (const entry of entries) {
    const { hits, longest } = phraseHits(entry, hay);
    if (hits > 0) {
      const catBoost = entry.category === preferred ? 0.15 : 0;
      const priBoost = (3 - CATEGORY_ORDER.indexOf(entry.category || "general")) * 0.02;
      const raw = Math.min(0.99, 0.35 + hits * 0.12 + longest / 80 + catBoost + priBoost);
      exact.push({ entry, score: dampPending(entry, raw) });
    }
  }
  exact.sort((a, b) => b.score - a.score);

  let fuzzy = [];
  try {
    fuzzy = fuse.search(q, { limit: 8 }).map((r) => ({
      entry: r.item,
      score: dampPending(r.item, 1 - (r.score || 0.5))
    }));
  } catch {
    fuzzy = [];
  }

  const merged = new Map();
  for (const row of [...exact, ...fuzzy]) {
    const prev = merged.get(row.entry.id);
    if (!prev || row.score > prev.score) merged.set(row.entry.id, row);
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const top = ranked[0];

  if (top && top.score >= 0.46) {
    return {
      match: top.entry,
      alternatives: ranked.slice(1, 4).map((r) => r.entry),
      source: exact.length ? "dictionary" : "fuzzy",
      confidence: Number(top.score.toFixed(2))
    };
  }

  return {
    match: null,
    alternatives: ranked.slice(0, 3).map((r) => r.entry),
    source: "none",
    confidence: top ? Number(top.score.toFixed(2)) : 0
  };
}

/**
 * Score a query without rendering anything — used by the chat router to decide
 * dictionary-instant vs send-to-Worker. Same code path as every other flow.
 */
export function scoreQuery(entries, fuse, query, opts = {}) {
  const found = searchDictionary(entries, fuse, query, opts);
  return {
    match: found.match,
    confidence: found.confidence,
    source: found.source,
    alternatives: found.alternatives,
    isPending: Boolean(found.match && found.match.status === "pending")
  };
}

export function fallbackAnswer(query, alternatives, screen) {
  const cat = screen?.category || detectScreen(query).category;
  const alt = alternatives[0];
  const generic = {
    payments: [
      "Open Settings → Payments and read any red or yellow banner first — Shopify usually names the hold or setup gap there.",
      "Confirm a primary card provider is Active (Shopify Payments or a third-party gateway). PayPal alone does not replace it.",
      "Turn Test mode off and make sure live API keys are saved, not sandbox keys.",
      "Check the store-owner email for a verification or identity request.",
      "Place a $1 test order in an incognito window, then refund it."
    ],
    shipping: [
      "Reproduce checkout with the customer's city, country, and postal code using a draft order.",
      "Go to Settings → Shipping and delivery → Manage rates. The country must sit in exactly one zone with at least one rate.",
      "Add a fallback flat rate in that zone so a carrier API failure cannot zero out methods.",
      "Confirm every physical product has a weight and belongs to a profile that covers that country.",
      "Temporarily disable shipping apps and retest."
    ],
    general: [
      "Read the banner at the top of the admin — it is usually more specific than the page title.",
      "Note the exact page path (Settings → … or Online Store → …).",
      "Undo the last theme, app, or domain change if the issue started today.",
      "Retry in an incognito window as the store owner to rule out staff permissions and extensions.",
      "If the banner names an error, type that exact phrase into Storescope search."
    ]
  };

  return {
    id: "fallback-local-001",
    category: cat,
    match_phrases: [],
    tags: [cat, "fallback"],
    synonyms: [],
    explanation: alt
      ? `No exact dictionary hit. Closest playbook is “${alt.explanation.slice(0, 90)}…” — use the steps below, or tap that related issue if it looks right.`
      : "No exact dictionary hit for this screen. These are the safest next checks for the area Shopify appears to be showing.",
    steps: generic[cat] || generic.general,
    target_ui_hint: alt?.target_ui_hint || "Admin home banner",
    arrow: alt?.arrow || { x: 0.5, y: 0.12 },
    source_category_db: "fallback"
  };
}
