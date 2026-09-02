# Field Notes backend

A tiny proxy server. Its only job: hold your Anthropic API key and forward
identification requests to it, so the key never ships inside the iOS app
(where it could be extracted from the binary).

## Run it locally first

1. Install Node.js 18+ if you don't have it: https://nodejs.org
2. In this folder:
   ```
   npm install
   cp .env.example .env
   ```
3. Open `.env` and paste in your real Anthropic API key
   (get one at https://console.anthropic.com — you'll need billing set up there,
   since every identification call costs a small amount of API usage).
4. Start it:
   ```
   npm start
   ```
5. Confirm it's alive: open http://localhost:3000/health — you should see `{"ok":true}`.

## Deploy it somewhere reachable from a phone

Pick one (all have free tiers that work fine for testing):

- **Render.com** — connect this folder as a repo, "New Web Service," set
  the `ANTHROPIC_API_KEY` environment variable in their dashboard, deploy.
  Easiest option if you're not sure.
- **Railway.app** — similar flow, also has a one-click deploy from a GitHub repo.
- **Fly.io** — a bit more setup, gives you more control if you outgrow the free tiers.

Whichever you pick, the two things you must do in their dashboard:
1. Set the `ANTHROPIC_API_KEY` environment variable (don't put it in code).
2. Note the public URL they give you (e.g. `https://field-notes-backend.onrender.com`)
   — you'll paste that into the iOS app's config next.

## Before you charge real users

- Add rate limiting (e.g. the `express-rate-limit` package) so one user
  can't run up your API bill.
- Consider adding a simple API key or App Store receipt check on `/identify`
  so only your app can call this endpoint, not anyone who finds the URL.
