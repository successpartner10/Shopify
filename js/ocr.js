let workerPromise = null;

function tessPaths() {
  return {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.1/4.0.0"
  };
}

export function ocrAvailable() {
  return typeof window.Tesseract !== "undefined" && navigator.onLine;
}

export async function getWorker(onProgress) {
  if (!window.Tesseract) throw new Error("Tesseract.js is not loaded");
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await window.Tesseract.createWorker("eng", 1, {
        ...tessPaths(),
        logger: (m) => {
          if (onProgress && m.status) onProgress(m);
        }
      });
      await worker.setParameters({
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1"
      });
      return worker;
    })();
  }
  return workerPromise;
}

export function frameToCanvas(source, maxW = 1280) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  if (!w || !h) throw new Error("Nothing to capture yet — wait for the frame to appear.");
  const scale = Math.min(1, maxW / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function recognize(source, onProgress) {
  const canvas = source instanceof HTMLCanvasElement ? source : frameToCanvas(source);
  const worker = await getWorker(onProgress);
  const result = await worker.recognize(canvas);
  const text = (result?.data?.text || "").replace(/[ \t]+\n/g, "\n").trim();
  return { text, canvas };
}
