function publicBase() {
  if (typeof location !== "undefined" && /^https?:/.test(location.protocol)) {
    const path = location.pathname.replace(/index\.html$/i, "");
    const base = path.endsWith("/") ? path : `${path}/`;
    return `${location.origin}${base}`;
  }
  return "https://storescope-7bz.pages.dev/";
}

export const APP_URL = publicBase();
export const APP_TITLE = "Storescope — Shopify Live Scanner";
export const APP_BLURB =
  "Point Storescope at your Shopify admin. Instant playbooks for payouts, shipping, themes, and checkout errors.";

export function fixUrl(id) {
  if (!id || String(id).startsWith("fallback")) return APP_URL;
  return `${APP_URL}?fix=${encodeURIComponent(id)}`;
}

export function queryUrl(q) {
  return `${APP_URL}?q=${encodeURIComponent(q)}`;
}

export function playbookMarkdown(entry) {
  if (!entry) return `${APP_TITLE}\n${APP_URL}`;
  const steps = (entry.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n");
  return [
    `# ${entry.target_ui_hint || "Storescope fix"}`,
    "",
    entry.explanation || "",
    "",
    steps,
    "",
    `Open this playbook: ${fixUrl(entry.id)}`,
    `App: ${APP_URL}`
  ].join("\n");
}

export function playbookText(entry) {
  if (!entry) {
    return `${APP_TITLE}\n${APP_BLURB}\n${APP_URL}`;
  }
  const steps = (entry.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n");
  return [
    `Storescope: ${entry.target_ui_hint}`,
    entry.explanation,
    "",
    steps,
    "",
    fixUrl(entry.id)
  ].join("\n");
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

export async function nativeShare({ title, text, url }) {
  if (!navigator.share) return false;
  const data = { title, text, url };
  if (navigator.canShare && !navigator.canShare(data)) {
    await navigator.share({ title, url });
    return true;
  }
  await navigator.share(data);
  return true;
}

export function canNativeShare() {
  return typeof navigator.share === "function";
}

export function parseInbound() {
  const params = new URLSearchParams(location.search);
  return {
    fix: params.get("fix") || "",
    q: params.get("q") || params.get("text") || params.get("title") || "",
    sharedUrl: params.get("url") || ""
  };
}

export function socialLinks(url, text) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return {
    x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
    telegram: `https://t.me/share/url?url=${u}&text=${t}`,
    email: `mailto:?subject=${encodeURIComponent(APP_TITLE)}&body=${encodeURIComponent(`${text}\n\n${url}`)}`,
    sms: `sms:?&body=${encodeURIComponent(`${text} ${url}`)}`
  };
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}
