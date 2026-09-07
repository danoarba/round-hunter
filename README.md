# Round Hunter (Hermes) — Railway-ready lead hunter + cold email command center

## Local

```bash
npm install && npm run build
cd server && npm install
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
cp ../.env.example .env   # fill Brevo (+ optional IMAP)
node index.js
```

Dashboard: `http://localhost:3001`

## Railway deploy

1. Push this repo to GitHub and create a Railway service from it.
2. Builder: **Dockerfile** (configured in `.railway/railway.ts`) or Nixpacks (`nixpacks.toml`).
3. Set Variables:
   - `BREVO_SMTP_USER`
   - `BREVO_SMTP_PASS`
   - `PUBLIC_URL` = your Railway HTTPS URL (optional if `RAILWAY_PUBLIC_DOMAIN` is set)
   - Optional: `IMAP_SERVER`, `IMAP_USER`, `IMAP_PASS`
4. Deploy. Health check: `GET /api/health`

SQLite (`server/clients.db`) lives on the container filesystem — add a Railway Volume on `/app/server` if you need persistence across redeploys.
