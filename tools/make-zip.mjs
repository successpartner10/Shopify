/** Rebuild Storescope-offline.zip from the current source. node tools/make-zip.mjs */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
const out = path.join(tmp, "Storescope-offline");
fs.mkdirSync(out, { recursive: true });

for (const item of ["index.html", "404.html", "manifest.json", "sw.js", "og.jpg", ".nojekyll", "css", "js", "data", "icons", "samples"]) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, item), { recursive: true });
}
fs.copyFileSync(path.join(root, "tools/offline-readme.txt"), path.join(out, "README.txt"));

const zip = path.join(root, "Storescope-offline.zip");
fs.rmSync(zip, { force: true });
execSync(`cd "${tmp}" && zip -rq "${zip}" Storescope-offline`);
console.log(`Wrote ${zip} (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
