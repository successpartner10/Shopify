/**
 * Screen fingerprints — recognise WHICH admin screen a screenshot shows,
 * without ever storing the screenshot.
 *
 * A dHash is 64 bits of "is this pixel brighter than the one to its right".
 * It cannot be turned back into an image, contains no customer data, no payout
 * figures and no API keys — so it is safe to keep in the shared playbook where a
 * real screenshot never could be.
 *
 * Text stays the PRIMARY signal (Shopify errors are literally text). This is a
 * secondary signal for "same screen", which survives OCR failing on low-res or
 * non-English screenshots.
 */

export const FP_VERSION = 1;

/**
 * Shopify admin puts a fixed left nav and top bar on every page, so hashing the
 * whole frame makes every screen look alike. We hash the content region only.
 */
const CONTENT_CROP = { x: 0.18, y: 0.08, w: 0.82, h: 0.92 };

/** dHash of one region: 9x8 grayscale, compare each pixel to its right neighbour. */
function regionHash(source, sx, sy, sw, sh) {
  const c = document.createElement("canvas");
  c.width = 9;
  c.height = 8;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 9, 8);
  const { data } = ctx.getImageData(0, 0, 9, 8);

  const gray = new Array(72);
  for (let i = 0; i < 72; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits += gray[row * 9 + col] > gray[row * 9 + col + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex; // 16 hex chars = 64 bits = 8 bytes
}

/**
 * Fingerprint = one hash of the content region plus four quadrant hashes.
 * Quadrants let a partial match still count when a merchant crops differently
 * or an app injects an extra panel.
 */
export function computeFingerprint(canvas) {
  try {
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return null;

    const cx = Math.round(W * CONTENT_CROP.x);
    const cy = Math.round(H * CONTENT_CROP.y);
    const cw = Math.round(W * CONTENT_CROP.w);
    const ch = Math.round(H * CONTENT_CROP.h);

    const tiles = [];
    for (const [tx, ty] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      tiles.push(regionHash(canvas, cx + (tx * cw) / 2, cy + (ty * ch) / 2, cw / 2, ch / 2));
    }

    return { v: FP_VERSION, dhash: regionHash(canvas, cx, cy, cw, ch), tiles };
  } catch {
    return null; // fingerprinting is an optimisation; never break the answer
  }
}

const HEX_BITS = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 1, 5: 2, 6: 2, 7: 3, 8: 1, 9: 2, a: 2, b: 3, c: 2, d: 3, e: 3, f: 4 };

/** Bit distance between two 16-char hex hashes. 0 = identical, 64 = opposite. */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    d += HEX_BITS[x.toString(16)] ?? 4;
  }
  return d;
}

/**
 * Compare two fingerprints → 0 (different screens) to ~0.95 (same screen).
 * Thresholds are deliberately conservative: a wrong "same screen" call sends the
 * merchant to the wrong playbook, which is worse than no call at all.
 */
export function compareFingerprints(a, b) {
  if (!a || !b || !a.dhash || !b.dhash) return 0;

  const d = hamming(a.dhash, b.dhash);
  const tileHits = (a.tiles || []).reduce((n, t, i) => n + (hamming(t, (b.tiles || [])[i]) <= 10 ? 1 : 0), 0);

  let score = 0;
  if (d <= 6) score = 0.9;
  else if (d <= 10) score = 0.75;
  else if (d <= 14) score = 0.6;
  else if (d <= 18 && tileHits >= 3) score = 0.55; // cropped differently, same screen
  else return 0;

  if (tileHits >= 3) score += 0.05;
  else if (tileHits <= 1) score -= 0.15; // hash agrees but layout does not: be suspicious

  return Math.max(0, Math.min(0.95, Number(score.toFixed(3))));
}

/** Best fingerprint matches across the dictionary. */
export function matchFingerprint(entries, fp, limit = 3) {
  if (!fp) return [];
  const out = [];
  for (const entry of entries || []) {
    let best = 0;
    for (const stored of entry.fingerprints || []) {
      const s = compareFingerprints(fp, stored);
      if (s > best) best = s;
    }
    if (best > 0) out.push({ entry, score: entry.status === "pending" ? best * 0.85 : best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
