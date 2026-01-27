# Deployment Guide

## Deploy to Remote Server

### 1. Copy Files to Server

```bash
# On your local machine
scp -r huly-mcp-server user@your-server:/opt/huly-mcp-server
```

### 2. Install on Server

```bash
# SSH to server
ssh user@your-server
cd /opt/huly-mcp-server
npm install
npm run build
```

### 3. Create Environment File

```bash
# Create .env file
cat > .env << EOF
HULY_URL=https://workspace.teasersoftware.com
HULY_EMAIL=hha.nguyen298@gmail.com
HULY_PASSWORD=Ha@29082002
HULY_WORKSPACE=Teaser Software
PORT=3000
EOF
```

### 4. Run with PM2

```bash
npm install -g pm2
pm2 start dist/http-server.js --name huly-mcp-server
pm2 save
pm2 startup  # Follow instructions to enable on boot
```

### 5. Configure Nginx (Optional but Recommended)

```nginx
server {
    listen 80;
    server_name your-server-domain.com;

    location /mcp {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Connect from Cursor

### Option 1: HTTP Endpoint (If Cursor Supports It)

Add to Cursor Settings:

```json
{
  "mcpServers": {
    "huly-remote": {
      "url": "http://your-server-ip:3000/mcp",
      "env": {}
    }
  }
}
```

### Option 2: SSH Tunnel + Stdio

If Cursor doesn't support HTTP MCP directly, use SSH tunnel:

```bash
# Create SSH tunnel
ssh -L 3000:localhost:3000 user@your-server
```

Then in Cursor, use localhost:3000.

### Option 3: Use Existing huly-mcp Package with Fix Script

Since Cursor MCP typically uses stdio, you might need to:

1. Keep using the existing `huly-mcp` package locally
2. Create a fix script that runs on your server to fix issues periodically
