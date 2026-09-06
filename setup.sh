#!/bin/bash
set -e

echo "Updating system..."
sudo apt update
sudo apt install -y nodejs npm python3-pip python3-venv

echo "Installing PM2..."
sudo npm install -g pm2

cd ~/hermes-os
echo "Installing frontend deps..."
npm install

cd server
echo "Setting up Python environment..."
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

echo "Installing backend deps..."
npm install

cd ~/hermes-os
echo "Starting frontend with PM2..."
pm2 start npm --name "hermes-frontend" -- run dev -- --host 0.0.0.0

cd server
echo "Starting backend with PM2..."
pm2 start index.js --name "hermes-backend"

echo "Saving PM2 state..."
pm2 save
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu
