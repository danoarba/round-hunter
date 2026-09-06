#!/bin/bash
# =====================================================
# Round Hunter - Complete Server Deploy Script
# Run this on your server (Ubuntu/Debian)
# Usage: bash deploy.sh
# =====================================================

set -e

echo "=== Round Hunter Server Deploy ==="
echo ""

# 1. Install Node.js 20
echo "[1/7] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install Python3, pip, venv
echo "[2/7] Installing Python3..."
sudo apt-get install -y python3 python3-pip python3-venv

# 3. Install Docker
echo "[3/7] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "Docker installed. NOTE: You may need to re-login for docker group to take effect."
else
    echo "Docker already installed."
fi

# 4. Install PM2 (keeps Node.js running 24/7)
echo "[4/7] Installing PM2..."
sudo npm install -g pm2

# 5. Copy project files
echo "[5/7] Setting up project directory..."
mkdir -p ~/round-hunter
cd ~/round-hunter

# Copy all files (this script assumes you rsync or scp the project here first)
echo "   Make sure you have copied your project files to ~/round-hunter/"

# 6. Setup server
echo "[6/7] Installing server dependencies..."
cd ~/round-hunter/server
npm install

# Setup Python venv
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install requests beautifulsoup4 python-dotenv ddgs premailer html2text

# 7. Pull Docker image
echo "[7/7] Pulling Google Maps Scraper Docker image..."
docker pull gosom/google-maps-scraper

echo ""
echo "=== Setup Complete! ==="
echo "Now create your .env file and start the server:"
echo ""
echo "  nano ~/round-hunter/server/.env"
echo "  pm2 start ~/round-hunter/server/index.js --name hermes"
echo "  pm2 save"
echo "  pm2 startup"
echo ""
