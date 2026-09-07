#!/bin/bash
# Local / VPS bootstrap (Railway uses Dockerfile or nixpacks.toml instead)
set -e
cd "$(dirname "$0")"

echo "=== Round Hunter setup ==="
npm install
npm run build
cd server
npm install
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

if [ ! -f .env ]; then
  cp ../.env.example .env
  echo "Created server/.env — fill BREVO_SMTP_* before sending email."
fi

echo ""
echo "Start:  cd server && node index.js"
echo "Open:   http://localhost:3001"
