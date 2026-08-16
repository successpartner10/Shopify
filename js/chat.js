/**
 * Chat core — routing, thread persistence, offline queue.
 *
 * Route for every message (plan §2.1):
 *   text, dictionary confidence >= 0.62 -> instant answer, tier "dictionary"
 *   text, 0.46 - 0.62                   -> Worker, near-miss passed as context
 *   text, < 0.46                        -> Worker, category context only
 *   any image                           -> always Worker (vision), never short-circuited
 *
 * Storescope has no Shopify OAuth or Admin API. Chat diagnoses and advises only.
 */

import { scoreQuery, detectScreen, fallbackAnswer, normalizeEntry, runtime } from "./dictionary.js";
import { openDb, THREADS, OUTBOX } from "./history.js";
import { computeFingerprint, matchFingerprint } from "./fingerprint.js";

export const CHAT_CONFIG = {
  INSTANT: 0.62,        // answer straight from the dictionary
  CONTEXT_FLOOR: 0.46,  // below this the near-miss is context only
  HISTORY_TURNS: 8,
  MAX_IMAGE_PX: 1280,
  IMAGE_QUALITY: 0.72,
  REQUEST_TIMEOUT: 15000
};

const listeners = new Set();
let deps = null;

export const chatState = {
  threadId: null,
  messages: [],       // { id, role, text, image, answer, tier, status, ts, resolved }
  busy: false,
  queued: 0
};

export function initChat(dependencies) {
  deps = dependencies; // { getEntries, getFuse, isReady, toast }
  chatState.threadId = loadThreadId();
  restoreThread().then(() => {
    emit();
    flushOutbox();
  });
  window.addEventListener("online", flushOutbox);
}

export function onChatChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(chatState); } catch { /* a broken listener must not stall chat */ }
  }
}

/* ------------------------------- ids + store ------------------------------ */

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function loadThreadId() {
  let id = localStorage.getItem("ss_thread_id");
  if (!id) {
    id = newId("th");
    localStorage.setItem("ss_thread_id", id);
  }
  return id;
}

export function newThread() {
  const id = newId("th");
  localStorage.setItem("ss_thread_id", id);
  chatState.threadId = id;
  chatState.messages = [];
  emit();
  persistThread();
}

async function persistThread() {
  try {
    const db = await openDb();
    const tx = db.transaction(THREADS, "readwrite");
    tx.objectStore(THREADS).put({
      id: chatState.threadId,
      updatedAt: Date.now(),
      // never store the image bytes — only that there was one
      messages: chatState.messages.map((m) => ({ ...m, image: m.image ? { name: m.image.name } : null }))
    });
  } catch { /* chat still works in memory */ }
}

async function restoreThread() {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const req = db.transaction(THREADS, "readonly").objectStore(THREADS).get(chatState.threadId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (rec && Array.isArray(rec.messages)) chatState.messages = rec.messages;
  } catch { /* first run */ }
}

/* --------------------------------- sending -------------------------------- */

export async function sendMessage({ text, file }) {
  const clean = String(text || "").trim();
  if (!clean && !file) return;

  const userMsg = {
    id: newId("m"),
    role: "user",
    text: clean,
    image: file ? { name: file.name || "screenshot.png" } : null,
    ts: Date.now()
  };
  chatState.messages.push(userMsg);
  chatState.busy = true;
  emit();

  try {
    // Static build (GitHub Pages / offline zip): no Worker, so answer locally.
    if (runtime.api === false) {
      noteStaticBuildOnce();
      if (file) return await answerFromScreenshotLocally(clean, file);
      return answerLocally(clean);
    }

    if (file) {
      await answerWithWorker({ text: clean, file, userMsg });
      return;
    }

    // ---- dictionary tier: same matcher as every other flow ----
    const query = withFollowUpContext(clean);
    const entries = deps?.getEntries?.() || [];
    const fuse = deps?.getFuse?.();
    const screen = detectScreen(query);
    const hit = fuse && entries.length
      ? scoreQuery(entries, fuse, query, { preferredCategory: screen.category })
      : { match: null, confidence: 0, alternatives: [] };

    if (hit.match && hit.confidence >= CHAT_CONFIG.INSTANT) {
      const e = normalizeEntry(hit.match);
      pushAnswer({
        tier: hit.isPending ? "community" : "dictionary",
        section: e.section,
        symptom: e.symptom,
        diagnosis: e.diagnosis,
        fix_steps: e.fix_steps,
        tags: e.tags,
        target_ui_hint: e.target_ui_hint,
        confidence: hit.confidence,
        entryId: e.id,
        question: clean
      });
      return;
    }

    if (!navigator.onLine) {
      await queueOffline({ text: clean });
      pushSystem("Saved — this sends as soon as you're back online. Dictionary answers still work offline.");
      return;
    }

    await answerWithWorker({
      text: clean,
      userMsg,
      context: buildContext(hit),
      nearMiss: hit.match && hit.confidence >= CHAT_CONFIG.CONTEXT_FLOOR ? hit.match : null
    });
  } catch (err) {
    if (file) {
      try {
        await answerFromScreenshotLocally(clean, file);
        return;
      } catch { /* fall through to generic tips */ }
    }
    pushLocalFallback(clean, err);
  } finally {
    chatState.busy = false;
    emit();
    persistThread();
  }
}

/** Follow-ups like "still broken" carry keywords from the last two turns. */
function withFollowUpContext(text) {
  if (text.split(/\s+/).length > 6) return text;
  const recent = chatState.messages.slice(-5, -1)
    .map((m) => m.text || m.answer?.symptom || "")
    .join(" ");
  return `${text} ${recent}`.trim().slice(0, 600);
}

function buildContext(hit) {
  const rows = [hit.match, ...(hit.alternatives || [])].filter(Boolean).slice(0, 3);
  return rows.map((e) => {
    const n = normalizeEntry(e);
    return { id: n.id, section: n.section, symptom: n.symptom, diagnosis: n.diagnosis, fix_steps: n.fix_steps, score: hit.confidence };
  });
}

async function answerWithWorker({ text, file, context = [], nearMiss = null }) {
  const payload = {
    thread_id: chatState.threadId,
    message: text,
    context_entries: context,
    history: chatState.messages.slice(-CHAT_CONFIG.HISTORY_TURNS).map((m) => ({
      role: m.role,
      text: m.role === "assistant" ? (m.answer?.diagnosis || m.text || "") : (m.text || ""),
      had_image: Boolean(m.image),
      tier: m.tier || null
    })),
    retry: chatState.messages.some((m) => m.retryFlag)
  };

  if (file) {
    const prepared = await prepareImage(file);
    payload.image = { mime: prepared.mime, b64: prepared.b64 };

    // Screen fingerprint: 8 bytes that say WHICH admin screen this is.
    // Never the image itself, so it is safe to keep in the shared playbook.
    const fp = computeFingerprint(prepared.canvas);
    if (fp) {
      payload.fingerprint = fp;
      const screenHits = matchFingerprint(deps?.getEntries?.() || [], fp);
      if (screenHits.length) {
        payload.screen_matches = screenHits.map((h) => ({
          id: normalizeEntry(h.entry).id,
          symptom: normalizeEntry(h.entry).symptom,
          score: h.score
        }));
      }
    }
    // Local OCR first: better dictionary context, and a graceful degrade path.
    const ocr = await tryOcr(prepared.canvas);
    if (ocr) {
      payload.ocr_text = ocr;
      const entries = deps?.getEntries?.() || [];
      const fuse = deps?.getFuse?.();
      if (fuse && entries.length) {
        const hit = scoreQuery(entries, fuse, `${text} ${ocr}`.trim());
        payload.context_entries = buildContext(hit);
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_CONFIG.REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch("./api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    pushSystem(body.message || "That's a lot of questions this hour. Dictionary answers still work.");
    return;
  }
  if (!res.ok) throw new Error(`worker ${res.status}`);

  const data = await res.json();
  pushAnswer({
    tier: data.tier === "ai" ? "ai" : "fallback",
    section: data.section,
    symptom: data.symptom,
    diagnosis: data.diagnosis,
    fix_steps: data.fix_steps,
    tags: data.tags,
    target_ui_hint: data.target_ui_hint,
    confidence: data.confidence,
    related: data.related,
    note: data.note,
    nearMiss: nearMiss ? normalizeEntry(nearMiss).symptom : null,
    model: data.model,
    hadImage: Boolean(file),
    fingerprint: payload.fingerprint || null,
    screen_summary: data.screen_summary || null,
    question: text
  });
}

/* ---------------------------- local-only answers -------------------------- */

let staticNoticeShown = false;
function noteStaticBuildOnce() {
  if (staticNoticeShown) return;
  staticNoticeShown = true;
  pushSystem(
    "This copy of Storescope answers from the built-in playbook only. " +
    "AI research and screenshot reading need the Cloudflare version of the app."
  );
}

/** Best available local answer: dictionary hit at any confidence, else safe checks. */
function answerLocally(text, extra = {}) {
  const entries = deps?.getEntries?.() || [];
  const fuse = deps?.getFuse?.();
  const query = withFollowUpContext(text);
  const hit = fuse && entries.length ? scoreQuery(entries, fuse, query) : { match: null, confidence: 0 };

  if (hit.match) {
    const e = normalizeEntry(hit.match);
    pushAnswer({
      tier: hit.isPending ? "community" : "dictionary",
      section: e.section,
      symptom: e.symptom,
      diagnosis: e.diagnosis,
      fix_steps: e.fix_steps,
      tags: e.tags,
      target_ui_hint: e.target_ui_hint,
      confidence: hit.confidence,
      entryId: e.id,
      question: text,
      ...extra
    });
    return;
  }
  pushLocalFallback(text, new Error("no dictionary match"));
}

/**
 * Screenshot with no Worker available: run the OCR we already ship and search
 * the playbook with what it reads. Same capability as the Screenshot flow.
 */
async function answerFromScreenshotLocally(text, file) {
  const prepared = await prepareImage(file);
  const entries = deps?.getEntries?.() || [];

  // Fingerprint first: it works even when OCR fails (low res, other languages).
  const fp = computeFingerprint(prepared.canvas);
  const screenHit = matchFingerprint(entries, fp)[0];
  if (screenHit && screenHit.score >= 0.75) {
    const e = normalizeEntry(screenHit.entry);
    pushAnswer({
      tier: e.status === "pending" ? "community" : "dictionary",
      section: e.section,
      symptom: e.symptom,
      diagnosis: e.diagnosis,
      fix_steps: e.fix_steps,
      tags: e.tags,
      target_ui_hint: e.target_ui_hint,
      confidence: screenHit.score,
      entryId: e.id,
      question: text,
      note: "Recognised this admin screen from the playbook, on your device.",
      hadImage: true,
      fingerprint: fp
    });
    return;
  }

  const ocr = await tryOcr(prepared.canvas);
  if (!ocr) {
    pushSystem("I couldn't read any text in that screenshot. Try typing the banner wording instead.");
    return;
  }
  answerLocally(`${text} ${ocr}`.trim(), {
    note: "Read from your screenshot on this device, then matched to the playbook.",
    hadImage: true,
    fingerprint: fp
  });
}

/* ------------------------------- answers ---------------------------------- */

function pushAnswer(answer) {
  chatState.messages.push({
    id: newId("m"),
    role: "assistant",
    tier: answer.tier,
    answer,
    ts: Date.now(),
    resolved: false
  });
  emit();
  persistThread();
}

function pushSystem(text) {
  chatState.messages.push({ id: newId("m"), role: "system", text, ts: Date.now() });
  emit();
  persistThread();
}

function pushLocalFallback(query, err) {
  const screen = detectScreen(query);
  const fb = fallbackAnswer(query, [], screen);
  pushAnswer({
    tier: "local",
    section: fb.category,
    symptom: fb.target_ui_hint,
    diagnosis: fb.explanation,
    fix_steps: fb.steps,
    tags: fb.tags,
    target_ui_hint: fb.target_ui_hint,
    confidence: 0.3,
    note: navigator.onLine
      ? "Couldn't reach the AI step, so these are the safest local checks."
      : "You're offline — these are the safest local checks.",
    question: query,
    error: String(err && err.message ? err.message : err)
  });
}

/* ------------------------------ resolution -------------------------------- */

/** "This fixed it" — save the exchange as a dictionary entry, source "chat". */
export async function markResolved(messageId) {
  const msg = chatState.messages.find((m) => m.id === messageId);
  if (!msg || !msg.answer) return { saved: false };
  msg.resolved = true;
  emit();
  persistThread();

  const a = msg.answer;
  // Dictionary-tier answers already exist in the playbook; nothing to save.
  if (a.tier === "dictionary" || a.tier === "community") {
    return { saved: false, reason: "already-in-dictionary" };
  }
  if (runtime.api === false) return { saved: false, reason: "static" };
  if (!navigator.onLine) return { saved: false, reason: "offline" };

  try {
    const res = await fetch("./api/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: chatState.threadId,
        question: a.question || "",
        section: a.section,
        symptom: a.symptom,
        tags: a.tags,
        diagnosis: a.diagnosis,
        fix_steps: a.fix_steps,
        target_ui_hint: a.target_ui_hint,
        confidence: a.confidence,
        had_image: Boolean(a.hadImage),
        fingerprint: a.fingerprint || null,
        screen_summary: a.screen_summary || null,
        model: a.model || null
      })
    });
    return await res.json();
  } catch (err) {
    return { saved: false, error: String(err && err.message) };
  }
}

/** "Didn't work" — continue the thread, telling the Worker not to repeat itself. */
export function markRetry(messageId) {
  const msg = chatState.messages.find((m) => m.id === messageId);
  if (msg) msg.retryFlag = true;
  emit();
}

/* ------------------------------ offline queue ----------------------------- */

async function queueOffline(item) {
  try {
    const db = await openDb();
    const tx = db.transaction(OUTBOX, "readwrite");
    tx.objectStore(OUTBOX).add({ ...item, thread_id: chatState.threadId, ts: Date.now() });
    chatState.queued += 1;
    emit();
  } catch { /* nothing to do */ }
}

export async function flushOutbox() {
  if (!navigator.onLine) return;
  let rows = [];
  try {
    const db = await openDb();
    rows = await new Promise((resolve, reject) => {
      const req = db.transaction(OUTBOX, "readonly").objectStore(OUTBOX).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (!rows.length) return;
    const db2 = await openDb();
    db2.transaction(OUTBOX, "readwrite").objectStore(OUTBOX).clear();
  } catch {
    return;
  }
  chatState.queued = 0;
  for (const row of rows) {
    try {
      await answerWithWorker({ text: row.text, context: [] });
    } catch { /* leave it; the user can resend */ }
  }
  emit();
}

/* --------------------------------- images --------------------------------- */

async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, CHAT_CONFIG.MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  // Re-encoding through canvas also drops EXIF (location, device) automatically.
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", CHAT_CONFIG.IMAGE_QUALITY);
  return { canvas, mime: "image/jpeg", b64: dataUrl.split(",")[1] };
}

async function tryOcr(canvas) {
  try {
    const { ocrAvailable, recognize } = await import("./ocr.js");
    if (!ocrAvailable()) return "";
    const { text } = await recognize(canvas);
    return (text || "").slice(0, 3000);
  } catch {
    return "";
  }
}
