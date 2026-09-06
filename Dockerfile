FROM ubuntu:24.04

# Install python, pip, curl and nodejs 22
RUN apt-get update && apt-get install -y curl python3 python3-pip python3-venv
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
RUN apt-get install -y nodejs

# Create app directory
WORKDIR /app

# Copy everything
COPY . .

# Install frontend and build
RUN npm install
RUN npm run build

# Install backend python dependencies
RUN pip3 install --break-system-packages requests beautifulsoup4 python-dotenv duckduckgo-search premailer html2text

# Install backend node dependencies
WORKDIR /app/server
RUN npm install

# Expose port 3001
EXPOSE 3001
ENV PORT=3001

# Start server
CMD ["node", "index.js"]
