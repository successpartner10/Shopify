/**
 * Chat UI — sheet, bubbles, composer.
 * Visual language and copy match the existing result card: plain language,
 * one primary action, numbered steps.
 */

import {
  initChat, onChatChange, sendMessage, markResolved, markRetry, chatState, newThread
} from "./chat.js";
import { ensureImageConsent } from "./consent.js";
import { runtime } from "./dictionary.js";
import { initDictation } from "./chat-voice.js";

const $ = (id) => document.getElementById(id);

const BADGES = {
  dictionary: { label: "Dictionary", cls: "b-dict", hint: "Answered instantly from the local playbook." },
  community: { label: "Dictionary (community)", cls: "b-comm", hint: "From a fix another merchant confirmed. Not reviewed yet." },
  ai: { label: "AI researched", cls: "b-ai", hint: "Researched by the AI using the playbook and this conversation." },
  fallback: { label: "Local tips", cls: "b-local", hint: "The AI step was unavailable — safest general checks." },
  local: { label: "Local tips", cls: "b-local", hint: "The AI step was unavailable — safest general checks." }
};

const EXAMPLES = [
  "My payouts are on hold",
  "No shipping methods at checkout",
  "Customers can't pay with card"
];

let deps = null;
let pendingFile = null;
let lastFocus = null;

export function mountChat(dependencies) {
  deps = dependencies;
  initChat(dependencies);
  wire();
  onChatChange(render);
  render();
}

/* --------------------------------- wiring --------------------------------- */

function wire() {
  $("chatFab")?.addEventListener("click", openChat);
  $("chatClose")?.addEventListener("click", closeChat);
  $("chatNew")?.addEventListener("click", () => {
    newThread();
    toast("Started a new conversation.");
  });
  $("chatBack")?.addEventListener("click", (e) => {
    if (e.target.id === "chatBack") closeChat();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("chatBack").hidden) closeChat();
  });

  $("chatForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("chatInput");
    const text = input.value.trim();
    if (!text && !pendingFile) return;
    input.value = "";
    const file = pendingFile;
    clearAttachment();
    await sendMessage({ text, file });
    input.focus();
  });

  $("chatAttach")?.addEventListener("click", async () => {
    // Static build reads screenshots on-device, so there is nothing to consent to.
    const ok = runtime.api === false ? true : await ensureImageConsent();
    if (!ok) return;
    $("chatFile").click();
  });

  $("chatFile")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) setAttachment(file);
  });

  $("chatInput")?.addEventListener("paste", async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    const ok = runtime.api === false ? true : await ensureImageConsent();
    if (ok) setAttachment(file);
  });

  $("chatChipRemove")?.addEventListener("click", clearAttachment);

  $("chatThread")?.addEventListener("click", async (e) => {
    const fixed = e.target.closest("[data-fixed]");
    if (fixed) return handleFixed(fixed.dataset.fixed);

    const retry = e.target.closest("[data-retry]");
    if (retry) {
      markRetry(retry.dataset.retry);
      $("chatInput").value = "That didn't work — ";
      $("chatInput").focus();
      return;
    }

    const share = e.target.closest("[data-share]");
    if (share) return deps?.onShare?.(findAnswer(share.dataset.share));

    const example = e.target.closest("[data-example]");
    if (example) {
      $("chatInput").value = example.dataset.example;
      $("chatForm").requestSubmit();
    }
  });

  initDictation({
    micBtn: $("chatMic"),
    input: $("chatInput"),
    statusEl: $("chatMicStatus"),
    toast
  });
}

function toast(msg) {
  if (deps?.toast) deps.toast(msg);
}

/* ------------------------------- open / close ----------------------------- */

export function openChat() {
  lastFocus = document.activeElement;
  $("chatBack").hidden = false;
  $("chatFab").setAttribute("aria-expanded", "true");
  document.body.classList.add("chat-open");
  setTimeout(() => $("chatInput")?.focus(), 40);
  scrollToEnd();
}

export function closeChat() {
  $("chatBack").hidden = true;
  $("chatFab").setAttribute("aria-expanded", "false");
  document.body.classList.remove("chat-open");
  lastFocus?.focus?.();
}

/* -------------------------------- attachment ------------------------------ */

function setAttachment(file) {
  pendingFile = file;
  const chip = $("chatChip");
  chip.hidden = false;
  $("chatChipName").textContent = file.name || "screenshot";
  const url = URL.createObjectURL(file);
  const img = $("chatChipThumb");
  img.src = url;
  img.onload = () => URL.revokeObjectURL(url);
  $("chatInput").placeholder = "Add a note about this screenshot (optional)";
}

function clearAttachment() {
  pendingFile = null;
  $("chatChip").hidden = true;
  $("chatChipThumb").removeAttribute("src");
  $("chatInput").placeholder = "Describe what you see, or attach a screenshot";
}

/* --------------------------------- render --------------------------------- */

function render() {
  const thread = $("chatThread");
  if (!thread) return;

  if (!chatState.messages.length) {
    thread.innerHTML = `
      <div class="chat-empty">
        <h3>What's happening in your admin?</h3>
        <p>Type it in your own words, or attach a screenshot. I check the local playbook first, then research anything new.</p>
        <div class="chat-examples">
          ${EXAMPLES.map((x) => `<button type="button" class="sample" data-example="${esc(x)}">${esc(x)}</button>`).join("")}
        </div>
      </div>`;
  } else {
    thread.innerHTML = chatState.messages.map(renderMessage).join("");
  }

  $("chatTyping").hidden = !chatState.busy;
  $("chatSend").disabled = chatState.busy;
  $("chatQueued").hidden = !chatState.queued;
  if (chatState.queued) $("chatQueued").textContent = `${chatState.queued} message${chatState.queued > 1 ? "s" : ""} waiting to send`;
  scrollToEnd();
}

function renderMessage(m) {
  if (m.role === "user") {
    return `
      <article class="bubble me">
        ${m.image ? `<span class="bubble-img">📎 ${esc(m.image.name)}</span>` : ""}
        ${m.text ? `<p>${esc(m.text)}</p>` : ""}
      </article>`;
  }
  if (m.role === "system") {
    return `<p class="chat-system">${esc(m.text)}</p>`;
  }

  const a = m.answer || {};
  const badge = BADGES[m.tier] || BADGES.fallback;
  const steps = (a.fix_steps || []).map((s, i) => `<li><span class="n">${i + 1}</span><p>${esc(s)}</p></li>`).join("");

  return `
    <article class="bubble bot">
      <div class="bubble-head">
        <span class="badge ${badge.cls}" title="${esc(badge.hint)}">${badge.label}</span>
        ${a.section ? `<span class="tag hit">${esc(a.section)}</span>` : ""}
        ${typeof a.confidence === "number" ? `<span class="tag">${Math.round(a.confidence * 100)}% match</span>` : ""}
      </div>
      ${a.symptom ? `<h4>${esc(a.symptom)}</h4>` : ""}
      ${a.nearMiss ? `<p class="chat-near">Closest playbook: ${esc(a.nearMiss)}</p>` : ""}
      ${a.note ? `<p class="chat-note">${esc(a.note)}</p>` : ""}
      <p class="expl">${esc(a.diagnosis || "")}</p>
      <ol class="steps-ol">${steps}</ol>
      ${a.target_ui_hint ? `<p class="chat-where"><b>Where to click:</b> ${esc(a.target_ui_hint)}</p>` : ""}
      <div class="bubble-actions">
        ${m.resolved
          ? `<span class="chat-resolved">✓ Saved to your playbook</span>`
          : `<button type="button" class="solid" data-fixed="${m.id}">This fixed it</button>
             <button type="button" class="linkish" data-retry="${m.id}">Didn't work</button>
             <button type="button" class="linkish" data-share="${m.id}">Share this fix</button>`}
      </div>
      <p class="chat-disclaimer">Storescope can't change anything in your store — these are steps for you to click.</p>
    </article>`;
}

async function handleFixed(messageId) {
  const res = await markResolved(messageId);
  if (res?.saved) {
    toast(res.mode === "merged" ? "Added your wording to an existing entry." : "Saved to the playbook for review.");
  } else if (res?.reason === "already-in-dictionary") {
    toast("Glad that worked — it's already in the playbook.");
  } else if (res?.reason === "offline") {
    toast("Marked as fixed. It saves to the playbook when you're online.");
  } else if (res?.reason === "static") {
    toast("Marked as fixed. This build keeps it on your device only.");
  } else {
    toast("Marked as fixed.");
  }
}

function findAnswer(messageId) {
  const m = chatState.messages.find((x) => x.id === messageId);
  if (!m?.answer) return null;
  const a = m.answer;
  return {
    id: a.entryId || `chat-${m.id}`,
    category: a.section,
    target_ui_hint: a.target_ui_hint || a.symptom,
    explanation: a.diagnosis,
    steps: a.fix_steps
  };
}

function scrollToEnd() {
  const thread = $("chatThread");
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
