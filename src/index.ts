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
  private token: string | null = null;

  constructor(config: HulyConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    console.error('Getting workspace token...');
    const token = await this.getWorkspaceToken();
    this.token = token;
    console.error('Token obtained, connecting to WebSocket...');
    
    await this.connectWithToken(token);
  }

  private async getWorkspaceToken(): Promise<string> {
    const baseUrl = this.config.url.replace(/\/$/, '');
    const accountUrl = `${baseUrl}/_accounts`;
    
    console.error(`Authenticating via: ${accountUrl}`);
    
    const loginPayload = {
      method: 'login',
      params: {
        email: this.config.email,
        password: this.config.password
      }
    };
    
    const loginResponse = await this.httpPost(accountUrl, loginPayload);
    console.error('Login response:', JSON.stringify(loginResponse).substring(0, 200));
    
    if (loginResponse.error) {
      throw new Error(`Login failed: ${JSON.stringify(loginResponse.error)}`);
    }
    
    const loginResult = loginResponse.result as { token?: string; account?: string } | undefined;
    if (!loginResult?.token) {
      throw new Error(`No token in login response: ${JSON.stringify(loginResponse)}`);
    }
    
    const workspaceName = this.config.workspace || 'Teaser Software';
    const selectPayload = {
      method: 'selectWorkspace',
      params: {
        workspaceUrl: workspaceName,
        kind: 'external'
      }
    };
    
    console.error(`Selecting workspace: ${workspaceName}`);
    const selectResponse = await this.httpPost(accountUrl, selectPayload, loginResult.token);
    console.error('Select workspace response:', JSON.stringify(selectResponse).substring(0, 200));
    
    if (selectResponse.error) {
      throw new Error(`Workspace selection failed: ${JSON.stringify(selectResponse.error)}`);
    }
    
    const wsToken = (selectResponse.result as { token?: string } | undefined)?.token;
    if (!wsToken || typeof wsToken !== 'string') {
      throw new Error(`No workspace token in response: ${JSON.stringify(selectResponse)}`);
    }
    
    return wsToken;
  }

  private async httpPost(url: string, body: Record<string, unknown>, token?: string): Promise<{ result?: Record<string, unknown>; error?: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`);
    }
  }

  private async connectWithToken(token: string): Promise<void> {
    const baseUrl = this.config.url.replace('https://', '').replace('http://', '').replace(/\/$/, '');
    const wsUrl = `wss://${baseUrl}/${token}`;
    
    console.error(`Connecting to WebSocket: ${wsUrl.substring(0, 50)}...`);
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        reject(new Error('WebSocket connection timeout'));
      }, 15000);

      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        clearTimeout(timeoutId);
        this.connected = true;
        console.error('WebSocket connected successfully');
        resolve();
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        this.connected = false;
        this.ws = null;
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('WebSocket error:', errorMsg);
        reject(new Error(`WebSocket error: ${errorMsg}`));
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeoutId);
        this.connected = false;
        console.error(`WebSocket closed: ${code} ${reason?.toString() || ''}`);
      });
      
      this.ws.on('unexpected-response', (request, response) => {
        clearTimeout(timeoutId);
        this.connected = false;
        this.ws = null;
        reject(new Error(`HTTP ${response.statusCode} instead of WebSocket`));
      });
    });
  }

  async getProjectSpaceId(projectName: string): Promise<string> {
    if (this.projectSpaceCache.has(projectName)) {
      return this.projectSpaceCache.get(projectName)!;
    }

    const projects = await this.listProjects();
    const project = projects.find((p) => 
      p.name === projectName || p._id === projectName || p.identifier === projectName
    );

    if (!project) {
      throw new Error(`Project not found: ${projectName}. Available projects: ${projects.map(p => p.name).join(', ')}`);
    }

    this.projectSpaceCache.set(projectName, project._id);
    return project._id;
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

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  private async getProject(spaceId: string): Promise<{ identifier: string; defaultIssueStatus?: string; name?: string } | null> {
    const projects = await this.listProjects();
    const project = projects.find((p) => p._id === spaceId);
    if (!project) {
      return null;
    }
    return {
      identifier: (project as { identifier?: string }).identifier || '',
      defaultIssueStatus: (project as { defaultIssueStatus?: string }).defaultIssueStatus,
      name: (project as { name?: string }).name,
    };
  }

  private async getNextIssueNumber(spaceId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const updateMessage = {
        method: 'updateDoc',
        params: [
          'tracker:class:Project',
          'core:class:Space',
          spaceId,
          { $inc: { sequence: 1 } },
          true,
        ],
      };

      this.ws.send(JSON.stringify(updateMessage));

      const timeout = setTimeout(() => {
        reject(new Error('Get next issue number timeout'));
      }, 10000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          if (response.result) {
            const result = response.result;
            const sequence = (result.object || result).sequence;
            resolve(sequence || 1);
          } else {
            resolve(1);
          }
        } catch (error) {
          resolve(1);
        }
      });
    });
  }

  async createIssue(issue: HulyIssue): Promise<{ id: string; number: number; identifier: string }> {
    if (!this.connected) {
      await this.connect();
    }

    const spaceId = await this.getProjectSpaceId(issue.project);
    const kindId = await this.getProjectKindId(issue.project);
    const project = await this.getProject(spaceId);
    
    if (!project) {
      throw new Error('Project not found');
    }

    const issueId = this.generateId();
    const sequence = await this.getNextIssueNumber(spaceId);
    const identifier = `${project.identifier}-${sequence}`;

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const createMessage = {
        method: 'addCollection',
        params: [
          'tracker:class:Issue',
          spaceId,
          spaceId,
          'tracker:class:Project',
          'issues',
          {
            title: issue.title,
            description: issue.description || '',
            priority: this.mapPriority(issue.priority || 'low'),
            kind: kindId,
            status: project.defaultIssueStatus || 'tracker:status:Backlog',
            number: sequence,
            identifier: identifier,
            assignee: null,
            component: null,
            estimation: 0,
            remainingTime: 0,
            reportedTime: 0,
            reports: 0,
            subIssues: 0,
            parents: [],
            childInfo: [],
            dueDate: null,
          },
          issueId,
        ],
      };

      this.ws.send(JSON.stringify(createMessage));

      const timeout = setTimeout(() => {
        reject(new Error('Create issue timeout'));
      }, 30000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          console.error('Create issue response:', JSON.stringify(response).substring(0, 500));
          if (response.error) {
            reject(new Error(`API error: ${JSON.stringify(response.error)}`));
          } else {
            resolve({
              id: issueId,
              number: sequence,
              identifier: identifier,
            });
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async listIssues(spaceId?: string): Promise<Array<{ _id: string; title: string; kind?: string; identifier?: string }>> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const query = spaceId ? { space: spaceId } : {};
      const listMessage = {
        method: 'findAll',
        params: ['tracker:class:Issue', query, { limit: 100 }],
      };

      this.ws.send(JSON.stringify(listMessage));

      const timeout = setTimeout(() => {
        reject(new Error('List issues timeout'));
      }, 30000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          console.error('List issues response:', JSON.stringify(response).substring(0, 500));
          if (response.result) {
            const result = response.result;
            if (Array.isArray(result)) {
              resolve(result);
            } else if (result.value && Array.isArray(result.value)) {
              resolve(result.value);
            } else if (result.docs && Array.isArray(result.docs)) {
              resolve(result.docs);
            } else {
              reject(new Error(`Unexpected result format: ${JSON.stringify(result).substring(0, 200)}`));
            }
          } else if (response.error) {
            reject(new Error(`API error: ${JSON.stringify(response.error)}`));
          } else {
            reject(new Error('Failed to list issues'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async listProjects(): Promise<Array<{ _id: string; name: string; identifier?: string; defaultIssueStatus?: string }>> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const listMessage = {
        method: 'findAll',
        params: ['tracker:class:Project', {}, {}],
      };

      this.ws.send(JSON.stringify(listMessage));

      const timeout = setTimeout(() => {
        reject(new Error('List projects timeout'));
      }, 30000);

      this.ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          console.error('List projects response:', JSON.stringify(response).substring(0, 500));
          if (response.result) {
            const result = response.result;
            if (Array.isArray(result)) {
              resolve(result);
            } else if (result.value && Array.isArray(result.value)) {
              resolve(result.value);
            } else if (result.docs && Array.isArray(result.docs)) {
              resolve(result.docs);
            } else {
              reject(new Error(`Unexpected result format: ${JSON.stringify(result).substring(0, 200)}`));
            }
          } else if (response.error) {
            reject(new Error(`API error: ${JSON.stringify(response.error)}`));
          } else {
            reject(new Error('Failed to list projects'));
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
              text: `Found ${issues.length} issues:\n\n${issues.map((i) => `- ${i.identifier || i._id}: ${i.title}`).join('\n')}`,
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
              text: `Found ${projects.length} projects:\n\n${projects.map((p) => `- ${p.identifier || p._id}: ${p.name}`).join('\n')}`,
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
