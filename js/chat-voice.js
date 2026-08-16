/**
 * Dictation for the chat composer (Web Speech API).
 * Fills the input — never auto-sends, so the merchant always reviews first.
 * Hidden entirely when unsupported (Firefox, some iOS builds) with no layout shift.
 */

export function initDictation({ micBtn, input, statusEl, toast }) {
  if (!micBtn || !input) return;

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    micBtn.hidden = true;
    return;
  }

  let rec = null;
  let listening = false;
  let baseText = "";

  function setListening(on) {
    listening = on;
    micBtn.classList.toggle("listening", on);
    micBtn.setAttribute("aria-pressed", String(on));
    micBtn.title = on ? "Stop dictation" : "Dictate your question";
    if (statusEl) {
      statusEl.hidden = !on;
      statusEl.textContent = on ? "Listening… tap the mic to stop" : "";
    }
  }

  function stop() {
    try { rec?.stop(); } catch { /* already stopped */ }
    setListening(false);
  }

  micBtn.addEventListener("click", () => {
    if (listening) return stop();

    rec = new Recognition();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    baseText = input.value.trim();

    rec.onstart = () => setListening(true);

    rec.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      input.value = (baseText ? baseText + " " : "") + text.trim();
    };

    rec.onerror = (event) => {
      setListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast?.("Microphone blocked. Allow mic access, or just type it.");
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        toast?.("Dictation stopped. You can type instead.");
      }
    };

    rec.onend = () => {
      setListening(false);
      input.focus();
    };

    try {
      rec.start();
    } catch {
      setListening(false);
      toast?.("Could not start dictation. You can type instead.");
    }
  });

  // Never leave the mic hot behind a closed sheet.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && listening) stop();
  });
}
