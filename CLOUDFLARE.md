# Cloudflare Pages (recommended host)

This is the host that lets you **make GitHub private** without paying.

| Host | Cost | Credit card | Works if GitHub is private |
|---|---|---|---|
| **Cloudflare Pages + Wrangler** | $0 | Not required | **Yes** — deploy from this folder, GitHub is optional |
| GitHub Pages (current) | $0 | No | **No** — private repos need GitHub Pro |
| Netlify / Vercel free | $0* | Often required now | Yes, but card friction |

Official Pages page: [cloudflare.com/products/pages](https://www.cloudflare.com/products/pages/) — *Start building for free — no credit card required.*

Live URL after deploy: `https://storescope-7bz.pages.dev` (or the next free name if that one is taken).

---

## What I need from you (only these two)

Nothing else. No domain, no Workers paid plan, no R2, no billing profile.

### 1. Account ID

1. Sign up or log in at [dash.cloudflare.com](https://dash.cloudflare.com) (free).
2. Open **Workers & Pages**.
3. Copy **Account ID** from the right sidebar (32 hex characters).

### 2. API token

1. Open [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).
2. **Create Token**.
3. Use the **Edit Cloudflare Workers** template  
   — or Custom token with:
   - `Account` → **Cloudflare Pages** → **Edit**
   - `Account` → **Account Settings** → **Read**
   - Account resources → *Include* → your account
4. Create and copy the token **once**. Paste both values in chat.

Do **not** commit the token to GitHub.

---

## After you paste those

I will:

1. `npx wrangler pages deploy` this PWA to your free `*.pages.dev` site.
2. Confirm HTTPS + share links + PWA install on that URL.
3. If you want, **make `successpartner10/Shopify` private** — GitHub Pages will go dark; Cloudflare stays up.

Redeploy later (still free):

```bash
npx wrangler pages deploy . --project-name=storescope
```
