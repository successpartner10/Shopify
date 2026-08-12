import { loadDictionaries, buildIndex, searchDictionary, fallbackAnswer, detectScreen } from "./dictionary.js";
import { saveSession, listSessions, clearSessions } from "./history.js";
import { canCapture, startTabCapture, stopStream } from "./capture.js";
import { ocrAvailable, recognize, frameToCanvas } from "./ocr.js";
import { SAMPLES } from "./samples.js";

const $ = (id) => document.getElementById(id);

const state = {
  entries: [],
  fuse: null,
  stream: null,
  paused: false,
  current: null,
  stepIndex: 0,
  lastText: "",
  lastSource: null,
  ready: false
};

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function setOnlineUi() {
  $("offlineBanner").hidden = navigator.onLine;
  $("netPill").textContent = navigator.onLine ? "Online" : "Offline";
  $("netPill").classList.toggle("warn", !navigator.onLine);
}

function hasSeenOnboarding() {
  return localStorage.getItem("ss_onboarded") === "1";
}
function markOnboarded() {
  localStorage.setItem("ss_onboarded", "1");
}

function showLanding(full) {
  $("landing").hidden = false;
  $("scanner").hidden = true;
  $("onboardingFull").hidden = !full;
  $("onboardingMini").hidden = full;
}

function showScanner() {
  $("landing").hidden = true;
  $("scanner").hidden = false;
}

function setLiveStatus(label, on = false) {
  $("livePill").textContent = label;
  $("livePill").classList.toggle("on", on);
  $("livePill").classList.toggle("warn", /pause|error|denied/i.test(label));
}

function setStill(src) {
  const img = $("stillImage");
  const video = $("liveVideo");
  video.hidden = true;
  img.hidden = false;
  img.src = src;
  state.lastSource = img;
}

function bindVideo(stream) {
  const video = $("liveVideo");
  const img = $("stillImage");
  img.hidden = true;
  video.hidden = false;
  video.srcObject = stream;
  video.play().catch(() => {});
  state.lastSource = video;
}

function clearArrow() {
  $("arrowLayer").innerHTML = "";
}

function drawArrow(target) {
  const svg = $("arrowLayer");
  const wrap = $("frameWrap");
  const media = !$("liveVideo").hidden ? $("liveVideo") : $("stillImage");
  if (!target || !media) { svg.innerHTML = ""; return; }

  const wr = wrap.getBoundingClientRect();
  const mr = media.getBoundingClientRect();
  const x = (mr.left - wr.left) + mr.width * target.x;
  const y = (mr.top - wr.top) + mr.height * target.y;
  const cardX = Math.min(wr.width - 36, Math.max(36, x + (target.x > 0.55 ? -120 : 120)));
  const cardY = Math.min(wr.height - 24, Math.max(24, y + (target.y > 0.45 ? -70 : 70)));

  svg.setAttribute("viewBox", `0 0 ${wr.width} ${wr.height}`);
  svg.innerHTML = `
    <defs>
      <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#3ee0b0"/>
      </marker>
      <filter id="ag" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#3ee0b0" flood-opacity="0.55"/>
      </filter>
    </defs>
    <circle cx="${x}" cy="${y}" r="16" fill="none" stroke="#3ee0b0" stroke-width="3" opacity="0.9"/>
    <circle cx="${x}" cy="${y}" r="6" fill="#3ee0b0"/>
    <path d="M ${cardX} ${cardY} Q ${(cardX + x) / 2} ${(cardY + y) / 2 - 20} ${x} ${y}"
      fill="none" stroke="#3ee0b0" stroke-width="3.2" marker-end="url(#ah)" filter="url(#ag)"/>
  `;
}

function renderResult(entry, meta) {
  state.current = entry;
  state.stepIndex = 0;
  $("emptyTip").hidden = true;
  $("tipBody").hidden = false;
  $("tipTitle").textContent = entry.target_ui_hint || "Next fix";
  $("tipExpl").textContent = entry.explanation;
  $("tipMeta").innerHTML = `
    <span class="tag hit">${entry.category}</span>
    <span class="tag">${meta.source}</span>
    <span class="tag">${Math.round((meta.confidence || 0) * 100)}% match</span>
  `;
  $("tipSteps").innerHTML = entry.steps.map((s, i) => `
    <li class="${i === 0 ? "current" : ""}" data-i="${i}">
      <span class="n">${i + 1}</span>
      <p>${s}</p>
    </li>
  `).join("");
  $("related").innerHTML = (meta.alternatives || []).map((a) =>
    `<button class="sample" data-alt="${a.id}"><b>${a.target_ui_hint}</b><span>${a.explanation}</span></button>`
  ).join("");
  $("ocrText").textContent = state.lastText || "";
  drawArrow(entry.arrow);
  saveSession({
    query: meta.query,
    title: entry.target_ui_hint,
    explanation: entry.explanation,
    steps: entry.steps,
    category: entry.category,
    source: meta.source,
    target: entry.target_ui_hint,
    confidence: meta.confidence
  }).catch(() => {});
}

function applyQuery(query, extras = {}) {
  const screen = detectScreen(query);
  const found = searchDictionary(state.entries, state.fuse, query, {
    preferredCategory: extras.category || screen.category
  });
  if (found.match) {
    renderResult(found.match, { ...found, query });
    return found.match;
  }
  const fb = fallbackAnswer(query, found.alternatives, screen);
  renderResult(fb, {
    source: "local-fallback",
    confidence: Math.max(found.confidence, 0.3),
    alternatives: found.alternatives,
    query
  });
  return fb;
}

async function runScan({ textOverride, reason } = {}) {
  if (!state.ready) return toast("Dictionary is still loading.");
  $("scanBtn").disabled = true;
  $("scanBtn").textContent = "Reading screen…";
  try {
    let text = textOverride || "";
    if (!text) {
      const src = state.lastSource;
      if (!src) throw new Error("Share a Shopify tab, upload a screenshot, or pick a sample first.");
      if (src.tagName === "VIDEO" && !src.videoWidth) {
        throw new Error("Waiting for the first frame. Try again in a second.");
      }
      if (ocrAvailable()) {
        $("ocrStatus").textContent = "OCR running…";
        const { text: ocrText } = await recognize(src, (m) => {
          if (m.progress) $("ocrStatus").textContent = `OCR ${Math.round(m.progress * 100)}%`;
        });
        text = ocrText;
      } else {
        throw new Error("Live OCR needs a network connection the first time. Type the banner text below, or use a sample.");
      }
    }
    state.lastText = text;
    $("ocrStatus").textContent = text ? `${text.split(/\s+/).length} words read` : "No text found";
    if (!text || text.replace(/\s+/g, "").length < 6) {
      toast("Could not read enough text. Type the error banner instead.");
      return;
    }
    applyQuery(reason ? `${reason}\n${text}` : text);
    toast("Fix ready — follow the numbered steps.");
  } catch (err) {
    toast(err.message || "Scan failed");
    $("ocrStatus").textContent = err.message || "Scan failed";
  } finally {
    $("scanBtn").disabled = false;
    $("scanBtn").textContent = "What's wrong?";
  }
}

async function beginCapture() {
  markOnboarded();
  showScanner();
  if (!canCapture()) {
    setLiveStatus("Upload only");
    toast("This browser cannot share tabs. Upload a screenshot instead.");
    $("fileInput").click();
    return;
  }
  try {
    stopStream(state.stream);
    const stream = await startTabCapture();
    state.stream = stream;
    state.paused = false;
    bindVideo(stream);
    setLiveStatus("Watching tab", true);
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      setLiveStatus("Share ended");
      state.stream = null;
    });
    toast("Pick your Shopify admin tab in the browser prompt.");
  } catch (err) {
    if (err.name === "NotAllowedError") {
      setLiveStatus("Share denied");
      toast("Screen share was dismissed. You can still upload a screenshot.");
    } else {
      setLiveStatus("Error");
      toast(err.message || "Could not start capture.");
    }
  }
}

function pauseCapture() {
  if (!state.stream) return toast("Nothing is being shared.");
  if (!state.paused) {
    try {
      const canvas = frameToCanvas($("liveVideo"));
      setStill(canvas.toDataURL("image/jpeg", 0.85));
    } catch {
      /* keep video */
    }
    state.stream.getTracks().forEach((t) => { t.enabled = false; });
    state.paused = true;
    setLiveStatus("Paused", false);
    $("pauseBtn").textContent = "Resume";
  } else {
    state.stream.getTracks().forEach((t) => { t.enabled = true; });
    bindVideo(state.stream);
    state.paused = false;
    setLiveStatus("Watching tab", true);
    $("pauseBtn").textContent = "Pause";
  }
}

function stopCapture() {
  stopStream(state.stream);
  state.stream = null;
  state.paused = false;
  $("liveVideo").srcObject = null;
  $("liveVideo").hidden = true;
  $("pauseBtn").textContent = "Pause";
  setLiveStatus("Stopped");
}

function loadSample(sample) {
  markOnboarded();
  showScanner();
  stopCapture();
  setStill(sample.image);
  setLiveStatus("Sample");
  state.lastText = sample.text;
  $("ocrStatus").textContent = "Sample text (no OCR needed)";
  applyQuery(sample.text);
}

async function onFile(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Choose a screenshot image.");
  markOnboarded();
  showScanner();
  stopCapture();
  const url = URL.createObjectURL(file);
  setStill(url);
  setLiveStatus("Screenshot");
  await runScan();
}

async function refreshHistory() {
  const rows = await listSessions();
  $("histList").innerHTML = rows.length
    ? rows.map((r) => `
      <article class="hist-item">
        <time>${new Date(r.createdAt).toLocaleString()}</time>
        <h3>${r.title || "Fix"}</h3>
        <p>${r.explanation || ""}</p>
        <ol>${(r.steps || []).map((s) => `<li>${s}</li>`).join("")}</ol>
      </article>
    `).join("")
    : `<p class="empty">No scans yet. Run “What's wrong?” and the playbook will land here — text only, no images.</p>`;
}

function wireUi() {
  on("startBtn", "click", beginCapture);
  on("startBtn2", "click", beginCapture);
  on("uploadBtn", "click", () => $("fileInput").click());
  on("uploadBtn2", "click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) onFile(file);
  });
  $("scanBtn").addEventListener("click", () => runScan());
  $("pauseBtn").addEventListener("click", pauseCapture);
  $("stopBtn").addEventListener("click", () => {
    stopCapture();
    showLanding(!hasSeenOnboarding());
  });
  $("howBtn").addEventListener("click", () => { $("howDrawer").hidden = false; });
  $("howClose").addEventListener("click", () => { $("howDrawer").hidden = true; });
  $("histBtn").addEventListener("click", async () => {
    await refreshHistory();
    $("histDrawer").hidden = false;
  });
  $("histClose").addEventListener("click", () => { $("histDrawer").hidden = true; });
  $("histClear").addEventListener("click", async () => {
    await clearSessions();
    await refreshHistory();
  });
  $("privBtn").addEventListener("click", () => { $("privDrawer").hidden = false; });
  $("privClose").addEventListener("click", () => {
    $("privDrawer").hidden = true;
    localStorage.setItem("ss_privacy", "1");
  });
  $("askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("askInput").value.trim();
    if (!q) return;
    showScanner();
    markOnboarded();
    state.lastText = [q, state.lastText].filter(Boolean).join("\n");
    applyQuery(state.lastText || q, {});
  });
  $("nextBtn").addEventListener("click", () => {
    if (!state.current) return;
    state.stepIndex = Math.min(state.current.steps.length - 1, state.stepIndex + 1);
    [...$("tipSteps").children].forEach((li, i) => li.classList.toggle("current", i === state.stepIndex));
  });
  $("dismissBtn").addEventListener("click", () => {
    $("tipBody").hidden = true;
    $("emptyTip").hidden = false;
    clearArrow();
  });
  $("tipSteps").addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    state.stepIndex = Number(li.dataset.i);
    [...$("tipSteps").children].forEach((n) => n.classList.toggle("current", n === li));
  });
  $("related").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-alt]");
    if (!btn) return;
    const entry = state.entries.find((x) => x.id === btn.dataset.alt);
    if (entry) renderResult(entry, { source: "related", confidence: 0.7, alternatives: [], query: entry.match_phrases[0] });
  });
  $("sampleList").innerHTML = SAMPLES.map((s) =>
    `<button class="sample" data-sample="${s.id}"><b>${s.title}</b><span>${s.blurb}</span></button>`
  ).join("");
  $("sampleList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sample]");
    if (!btn) return;
    const sample = SAMPLES.find((s) => s.id === btn.dataset.sample);
    if (sample) loadSample(sample);
  });
  $("howDrawer").addEventListener("click", (e) => { if (e.target.id === "howDrawer") e.target.hidden = true; });
  $("histDrawer").addEventListener("click", (e) => { if (e.target.id === "histDrawer") e.target.hidden = true; });
  $("privDrawer").addEventListener("click", (e) => { if (e.target.id === "privDrawer") e.target.hidden = true; });

  window.addEventListener("online", setOnlineUi);
  window.addEventListener("offline", setOnlineUi);
  window.addEventListener("resize", () => { if (state.current) drawArrow(state.current.arrow); });
}

async function boot() {
  wireUi();
  setOnlineUi();
  showLanding(!hasSeenOnboarding());
  if (!localStorage.getItem("ss_privacy")) $("privDrawer").hidden = false;
  if (!canCapture()) $("capNote").textContent = "This browser cannot share tabs. Use Upload screenshot or a sample.";

  try {
    const { entries, errors } = await loadDictionaries();
    state.entries = entries;
    state.fuse = buildIndex(entries);
    state.ready = true;
    $("dictPill").textContent = `${entries.length} playbooks`;
    if (errors.length) toast("Some dictionaries failed to load.");
  } catch (err) {
    toast("Could not load the local dictionary.");
    console.error(err);
  }

  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch { /* optional */ }
  }
}

boot();
