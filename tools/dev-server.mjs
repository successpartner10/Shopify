/**
 * Local dev server: static files + the Pages Functions in ./functions.
 * Node only, no wrangler needed.  node tools/dev-server.mjs [port]
 *
 * AGENT_KV is faked on disk (.dev-kv.json) and env.AI is a canned responder,
 * so you can click through the whole chat flow offline. Real deploys use
 * `npx wrangler pages dev .` which supplies the genuine bindings.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 4173);
const KV_FILE = path.join(root, ".dev-kv.json");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".webmanifest": "application/manifest+json", ".md": "text/markdown; charset=utf-8"
};

/* ------------------------------ fake bindings ----------------------------- */

function loadKv() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(KV_FILE, "utf8")))); }
  catch { return new Map(); }
}
const store = loadKv();
const AGENT_KV = {
  async get(key, type) {
    const v = store.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  },
  async put(key, value) {
    store.set(key, value);
    fs.writeFileSync(KV_FILE, JSON.stringify(Object.fromEntries(store), null, 2));
  },
  async delete(key) { store.delete(key); }
};

const ASSETS = {
  async fetch(req) {
    const url = new URL(typeof req === "string" ? req : req.url);
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(file, "utf8"), { status: 200 });
  }
};

/** Canned "model": echoes a plausible, guard-clean JSON answer. */
const AI = {
  async run(model, input) {
    const prompt = String(input.prompt || input.messages?.[1]?.content || "");
    const isShipping = /shipping|carrier|rate|delivery/i.test(prompt);
    const isVision = model.includes("vision");
    const section = isShipping ? "shipping" : /payout|payment|card|paypal/i.test(prompt) ? "payments" : "general";
    await new Promise((r) => setTimeout(r, 700)); // feel realistic
    return {
      response: JSON.stringify({
        section,
        symptom: isVision ? "Screenshot read: admin banner needs attention" : "Issue diagnosed from your description",
        diagnosis:
          `This is the local dev model, so the wording is canned — but the plumbing is real. ` +
          `Storescope cannot open or change your store, so every step below is something you do in your own admin. ` +
          (isVision ? "The attached screenshot was received by the vision path and OCR text was included." : ""),
        fix_steps: [
          `Open ${section === "shipping" ? "Settings then Shipping and delivery" : section === "payments" ? "Settings then Payments" : "your Shopify admin home"}.`,
          "Read the banner at the top of the page and note the exact wording.",
          "Make the single change it asks for, then tap Save.",
          "Reload the page in a private window to confirm the banner is gone."
        ],
        tags: [section, "dev", "canned"],
        target_ui_hint: section === "shipping" ? "Settings > Shipping and delivery" : section === "payments" ? "Settings > Payments" : "Admin home",
        confidence: 0.72
      })
    };
  }
};

const env = { AGENT_KV, ASSETS, AI, APP_PUBLIC_URL: `http://localhost:${PORT}` };

/* --------------------------------- server --------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.replace("/api/", "").replace(/\/$/, "");
    const modPath = path.join(root, "functions/api", `${name}.js`);
    if (!fs.existsSync(modPath)) return send(res, 404, { error: "no such function" });

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const request = new Request(`http://localhost:${PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { ...req.headers, "cf-connecting-ip": "127.0.0.1" },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body
    });

    try {
      const mod = await import(modPath + `?t=${Date.now()}`);
      const handler = mod[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`] || mod.onRequest;
      if (!handler) return send(res, 405, { error: "method not allowed" });
      const out = await handler({ request, env, params: {} });
      const text = await out.text();
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(text);
    } catch (err) {
      console.error("function error", err);
      return send(res, 500, { error: String(err && err.message) });
    }
  }

  let file = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === "/" || fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end(fs.existsSync(path.join(root, "404.html")) ? fs.readFileSync(path.join(root, "404.html")) : "not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(fs.readFileSync(file));
});

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Storescope dev server → http://0.0.0.0:${PORT}`);
  console.log(`Fake AGENT_KV → ${KV_FILE} (${store.size} keys)`);
  console.log("Canned AI model. Use `npx wrangler pages dev .` for real Workers AI.");
});
