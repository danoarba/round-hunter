FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PORT=3001
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates python3 python3-pip python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

RUN python3 -m venv /app/server/venv \
    && /app/server/venv/bin/pip install --upgrade pip \
    && /app/server/venv/bin/pip install -r /app/server/requirements.txt

WORKDIR /app/server
RUN npm install

EXPOSE 3001

CMD ["node", "index.js"]
