export function canCapture() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

export async function startTabCapture() {
  if (!canCapture()) {
    const err = new Error("Screen capture is not supported in this browser. Upload a screenshot instead.");
    err.code = "UNSUPPORTED";
    throw err;
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: "browser",
      frameRate: 8,
      width: { ideal: 1440 },
      height: { ideal: 900 }
    },
    audio: false,
    preferCurrentTab: false,
    surfaceSwitching: "include",
    selfBrowserSurface: "exclude",
    systemAudio: "exclude"
  });
  return stream;
}

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

export async function openPip(element) {
  if (!("documentPictureInPicture" in window)) return null;
  const pip = await documentPictureInPicture.requestWindow({
    width: 420,
    height: 720
  });
  for (const sheet of document.styleSheets) {
    try {
      const href = sheet.href;
      if (href) {
        const link = pip.document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        pip.document.head.appendChild(link);
      }
    } catch {
      /* ignore cross-origin */
    }
  }
  const style = pip.document.createElement("style");
  style.textContent = "body{margin:0;background:#07090c;color:#edf2f7;font-family:system-ui,sans-serif}";
  pip.document.head.appendChild(style);
  pip.document.body.appendChild(element);
  return pip;
}
