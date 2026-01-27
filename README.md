# Huly MCP Server

Custom MCP server for Huly workspace built from scratch. Runs on your remote server and connects to Huly WebSocket API.

## Features

- ✅ **Built from scratch** - No dependencies on buggy `huly-mcp` package
- ✅ **Fixes all bugs** - Correct `attachedToClass`, `collection`, and `kind` fields
- ✅ **Auto-resolves project kind IDs** - Automatically gets correct task type for each project
- ✅ **Runs on remote server** - Deploy on your server where Huly is hosted
- ✅ **Connects via SSH** - Cursor connects via SSH to remote server

## Installation on Remote Server

```bash
cd /path/to/huly-mcp-server
npm install
npm run build
```

## Configuration

Create `.env` file or set environment variables:

```bash
HULY_URL=https://workspace.teasersoftware.com
HULY_EMAIL=your-email@example.com
HULY_PASSWORD=your-password
HULY_WORKSPACE=Teaser Software
PORT=3000
```

## Running the Server

### On Remote Server

```bash
npm start
# or for development
npm run dev
```

The server uses stdio transport (standard MCP protocol).

## Connecting from Cursor

### For HTTP Server (Remote)

Add to Cursor Settings → MCP Servers:

```json
{
  "mcpServers": {
    "huly-remote": {
      "url": "http://your-server-ip:3000/mcp",
      "env": {
        "HULY_URL": "https://workspace.teasersoftware.com",
        "HULY_EMAIL": "your-email@example.com",
        "HULY_PASSWORD": "your-password"
      }
    }
  }
}
```

### For Stdio Server (Local)

```json
{
  "mcpServers": {
    "huly-local": {
      "command": "node",
      "args": ["/absolute/path/to/huly-mcp-server/dist/index.js"],
      "env": {
        "HULY_URL": "https://workspace.teasersoftware.com",
        "HULY_EMAIL": "your-email@example.com",
        "HULY_PASSWORD": "your-password"
      }
    }
  }
}
```

## How It Works

1. **Connects to Huly**: Uses WebSocket API to connect to your Huly workspace
2. **Resolves Project IDs**: Automatically converts project names to space IDs
3. **Gets Correct Kind ID**: Queries existing issues to get the correct task type ID for each project
4. **Creates Issues Correctly**: Sets all fields correctly:
   - `attachedToClass: "tracker:class:Issue"`
   - `collection: "subIssues"`
   - `kind: <project-specific-id>`

## Available Tools

- `create_issue` - Create issues with correct fields
- `list_issues` - List issues from projects
- `list_projects` - List all projects

## Development

```bash
npm run dev:http  # Run HTTP server in development
npm run dev       # Run stdio server in development
npm run build     # Build TypeScript
```

## Deployment on Remote Server

### 1. Copy to Server

```bash
scp -r huly-mcp-server user@your-server:/opt/huly-mcp-server
```

### 2. Install and Build

```bash
ssh user@your-server
cd /opt/huly-mcp-server
npm install
npm run build
```

### 3. Create .env File

```bash
cat > .env << EOF
HULY_URL=https://workspace.teasersoftware.com
HULY_EMAIL=hha.nguyen298@gmail.com
HULY_PASSWORD=Ha@29082002
HULY_WORKSPACE=Teaser Software
EOF
```

### 4. Test Locally on Server

```bash
node dist/index.js
# Should see: "Huly MCP Server running on stdio"
```

The server is ready! Cursor will connect via SSH.
