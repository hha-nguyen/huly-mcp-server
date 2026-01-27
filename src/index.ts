#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

interface HulyConfig {
  url: string;
  email: string;
  password: string;
  workspace?: string;
}

interface HulyIssue {
  title: string;
  description?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  project: string;
  assignee?: string;
  component?: string;
}

class HulyClient {
  private ws: WebSocket | null = null;
  private config: HulyConfig;
  private connected: boolean = false;
  private projectKindCache: Map<string, string> = new Map();
  private projectSpaceCache: Map<string, string> = new Map();

  constructor(config: HulyConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    const wsUrlFromEnv = process.env.HULY_WS_URL;
    const baseUrl = this.config.url.replace('https://', '').replace('http://', '').replace(/\/$/, '');
    
    const urlsToTry = wsUrlFromEnv ? [wsUrlFromEnv] : [
      `wss://${baseUrl}/_transactor`,
      `wss://${baseUrl}/_collaborator`,
      `wss://${baseUrl}`,
      `wss://${baseUrl}/ws`,
    ];

    let lastError: Error | null = null;
    
    for (const wsUrl of urlsToTry) {
      try {
        console.error(`Trying WebSocket URL: ${wsUrl}`);
        await this.tryConnect(wsUrl);
        return;
      } catch (error) {
        console.error(`Failed to connect to ${wsUrl}:`, error instanceof Error ? error.message : String(error));
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    
    throw lastError || new Error('Failed to connect to any WebSocket endpoint');
  }

  private async tryConnect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        reject(new Error(`Connection timeout for ${wsUrl}`));
      }, 10000);

      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', async () => {
        clearTimeout(timeoutId);
        console.error(`WebSocket connected to ${wsUrl}, authenticating...`);
        try {
          await this.authenticate();
          this.connected = true;
          console.error('Authentication successful');
          resolve();
        } catch (error) {
          console.error('Authentication failed:', error);
          this.ws?.close();
          this.ws = null;
          reject(error);
        }
      });

      this.ws.on('error', (error: Error & { code?: string; statusCode?: number }) => {
        clearTimeout(timeoutId);
        this.connected = false;
        this.ws = null;
        const errorMsg = error instanceof Error ? error.message : String(error);
        reject(new Error(`WebSocket error: ${errorMsg}`));
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeoutId);
        this.connected = false;
        const reasonStr = reason?.toString() || '';
        console.error(`WebSocket closed: code=${code}, reason=${reasonStr}`);
      });
      
      this.ws.on('unexpected-response', (request, response) => {
        clearTimeout(timeoutId);
        this.connected = false;
        this.ws = null;
        const statusCode = response.statusCode;
        reject(new Error(`HTTP ${statusCode} instead of WebSocket upgrade`));
      });
    });
  }

  private async authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const authMessage = {
        method: 'account:login',
        params: {
          email: this.config.email,
          password: this.config.password,
        },
      };

      this.ws.send(JSON.stringify(authMessage));

      const timeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 10000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          if (response.result) {
            resolve();
          } else {
            reject(new Error('Authentication failed'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async getProjectSpaceId(projectName: string): Promise<string> {
    if (this.projectSpaceCache.has(projectName)) {
      return this.projectSpaceCache.get(projectName)!;
    }

    const projects = await this.listProjects();
    const project = projects.find((p: { name: string; id: string }) => 
      p.name === projectName || p.id === projectName
    );

    if (!project) {
      throw new Error(`Project not found: ${projectName}`);
    }

    this.projectSpaceCache.set(projectName, project.id);
    return project.id;
  }

  async getProjectKindId(projectName: string): Promise<string> {
    const spaceId = await this.getProjectSpaceId(projectName);
    
    if (this.projectKindCache.has(spaceId)) {
      return this.projectKindCache.get(spaceId)!;
    }

    const issues = await this.listIssues(spaceId);
    if (issues.length > 0 && issues[0].kind) {
      this.projectKindCache.set(spaceId, issues[0].kind);
      return issues[0].kind;
    }

    throw new Error(`Could not find task type for project: ${projectName}. Please create one issue manually first.`);
  }

  async createIssue(issue: HulyIssue): Promise<{ id: string; number: number; identifier: string }> {
    if (!this.connected) {
      await this.connect();
    }

    const spaceId = await this.getProjectSpaceId(issue.project);
    const kindId = await this.getProjectKindId(issue.project);

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const createMessage = {
        method: 'tracker:create:Issue',
        params: {
          space: spaceId,
          data: {
            title: issue.title,
            description: issue.description || '',
            priority: this.mapPriority(issue.priority || 'low'),
            kind: kindId,
            attachedToClass: 'tracker:class:Issue',
            collection: 'subIssues',
            status: 'tracker:status:Backlog',
          },
        },
      };

      this.ws.send(JSON.stringify(createMessage));

      const timeout = setTimeout(() => {
        reject(new Error('Create issue timeout'));
      }, 30000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          if (response.result) {
            resolve({
              id: response.result.id,
              number: response.result.number,
              identifier: response.result.identifier,
            });
          } else {
            reject(new Error(response.error || 'Failed to create issue'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async listIssues(spaceId?: string): Promise<Array<{ id: string; title: string; kind?: string }>> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const listMessage = {
        method: 'tracker:query:Issue',
        params: spaceId ? { space: spaceId } : {},
      };

      this.ws.send(JSON.stringify(listMessage));

      const timeout = setTimeout(() => {
        reject(new Error('List issues timeout'));
      }, 30000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          if (response.result) {
            resolve(response.result);
          } else {
            reject(new Error(response.error || 'Failed to list issues'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const listMessage = {
        method: 'tracker:query:Project',
        params: {},
      };

      this.ws.send(JSON.stringify(listMessage));

      const timeout = setTimeout(() => {
        reject(new Error('List projects timeout'));
      }, 30000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          if (response.result) {
            resolve(response.result);
          } else {
            reject(new Error(response.error || 'Failed to list projects'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private mapPriority(priority: string): number {
    const priorityMap: Record<string, number> = {
      urgent: 3,
      high: 2,
      medium: 1,
      low: 0,
    };
    return priorityMap[priority] || 0;
  }
}

const server = new Server(
  {
    name: 'huly-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

let hulyClient: HulyClient | null = null;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'create_issue',
        description: 'Create a new issue in Huly with correct fields',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Issue title' },
            description: { type: 'string', description: 'Issue description (Markdown supported)' },
            priority: {
              type: 'string',
              enum: ['urgent', 'high', 'medium', 'low'],
              description: 'Issue priority',
            },
            project: {
              type: 'string',
              description: 'Project identifier or name (required)',
            },
            assignee: {
              type: 'string',
              description: 'Person name to assign the issue to (optional)',
            },
            component: {
              type: 'string',
              description: 'Component name to assign the issue to (optional)',
            },
          },
          required: ['title', 'project'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues from Huly',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Filter by project identifier (optional)',
            },
          },
        },
      },
      {
        name: 'list_projects',
        description: 'List all projects in Huly',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!hulyClient) {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const envPath = path.join(__dirname, '..', '.env');
    
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      envContent.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const equalIndex = trimmed.indexOf('=');
          if (equalIndex > 0) {
            const key = trimmed.substring(0, equalIndex).trim();
            let value = trimmed.substring(equalIndex + 1).trim();
            if (value.startsWith('"') && value.endsWith('"')) {
              value = value.slice(1, -1);
            } else if (value.startsWith("'") && value.endsWith("'")) {
              value = value.slice(1, -1);
            }
            if (key && value) {
              process.env[key] = value;
            }
          }
        }
      });
    }

    const config: HulyConfig = {
      url: process.env.HULY_URL || '',
      email: process.env.HULY_EMAIL || '',
      password: process.env.HULY_PASSWORD || '',
      workspace: process.env.HULY_WORKSPACE,
    };

    if (!config.url || !config.email || !config.password) {
      throw new Error('Missing required environment variables: HULY_URL, HULY_EMAIL, HULY_PASSWORD');
    }

    hulyClient = new HulyClient(config);
    await hulyClient.connect();
  }

  try {
    switch (name) {
      case 'create_issue': {
        if (!args || typeof args !== 'object') {
          throw new Error('Invalid arguments for create_issue');
        }
        const issue = args as unknown as HulyIssue;
        const result = await hulyClient.createIssue(issue);
        return {
          content: [
            {
              type: 'text',
              text: `✅ Created issue ${result.number}: ${issue.title}\nID: ${result.id}\nIdentifier: ${result.identifier}`,
            },
          ],
        };
      }

      case 'list_issues': {
        const project = args && typeof args === 'object' && 'project' in args 
          ? (args as { project?: string }).project 
          : undefined;
        let spaceId: string | undefined;
        if (project) {
          spaceId = await hulyClient.getProjectSpaceId(project);
        }
        const issues = await hulyClient.listIssues(spaceId);
        return {
          content: [
            {
              type: 'text',
              text: `Found ${issues.length} issues:\n\n${issues.map((i) => `- ${i.id}: ${i.title}`).join('\n')}`,
            },
          ],
        };
      }

      case 'list_projects': {
        const projects = await hulyClient.listProjects();
        return {
          content: [
            {
              type: 'text',
              text: `Found ${projects.length} projects:\n\n${projects.map((p) => `- ${p.id}: ${p.name}`).join('\n')}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('MCP Tool Error:', errorMessage);
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Huly MCP Server running on stdio');
}

main().catch(console.error);
