/**
 * One-time consent before any screenshot leaves the device.
 *
 * The rest of Storescope processes pixels locally, and the Privacy panel says so.
 * Vision chat is the one exception, so it gets an explicit, revocable opt-in.
 */

const KEY = "ss_img_consent";

export function hasImageConsent() {
  return localStorage.getItem(KEY) === "1";
}

export function revokeImageConsent() {
  localStorage.removeItem(KEY);
}

/** Resolves true if the user has (or just gave) consent. */
export function ensureImageConsent() {
  if (hasImageConsent()) return Promise.resolve(true);

  const back = document.getElementById("consentBack");
  const accept = document.getElementById("consentAccept");
  const cancel = document.getElementById("consentCancel");
  if (!back || !accept || !cancel) return Promise.resolve(false);

  back.hidden = false;
  accept.focus();

  return new Promise((resolve) => {
    function done(ok) {
      back.hidden = true;
      accept.removeEventListener("click", onAccept);
      cancel.removeEventListener("click", onCancel);
      back.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(ok);
    }
    function onAccept() {
      localStorage.setItem(KEY, "1");
      done(true);
    }
    function onCancel() { done(false); }
    function onBackdrop(e) { if (e.target === back) done(false); }
    function onKey(e) { if (e.key === "Escape") done(false); }

    accept.addEventListener("click", onAccept);
    cancel.addEventListener("click", onCancel);
    back.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

/** Wires the "Turn off screenshot sending" control in the Privacy panel. */
export function wireConsentControls(toast) {
  const btn = document.getElementById("consentRevoke");
  if (!btn) return;
  const paint = () => {
    btn.textContent = hasImageConsent()
      ? "Turn off sending screenshots in chat"
      : "Screenshot sending is off";
    btn.disabled = !hasImageConsent();
  };
  btn.addEventListener("click", () => {
    revokeImageConsent();
    paint();
    toast?.("Chat will ask again before sending any screenshot.");
  });
  paint();
}
