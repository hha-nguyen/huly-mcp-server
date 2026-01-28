#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import pg from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import { USER_MAPPING, ASSIGNEE_MAPPING } from './user-mapping.js';
import apiClientPkg from '@hcengineering/api-client';
const { connect, NodeWebSocketFactory } = apiClientPkg;
import type { PlatformClient } from '@hcengineering/api-client';
import trackerModule from '@hcengineering/tracker';
const tracker = (trackerModule as { default?: typeof trackerModule }).default ?? trackerModule;

process.on('uncaughtException', (err) => {
  if (err.message?.includes('Data read, but end of buffer not reached')) {
    return;
  }
  throw err;
});

process.on('unhandledRejection', (reason) => {
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const msg = String(reason.message);
    if (msg.includes('Data read, but end of buffer not reached')) {
      return;
    }
  }
});

interface HulyConfig {
  url: string;
  email: string;
  password: string;
  workspace?: string;
  dbHost?: string;
  dbPort?: number;
  dbUser?: string;
  dbPassword?: string;
  dbName?: string;
}

interface HulyIssue {
  title: string;
  description?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  project: string;
  assignee?: string;
  assigner?: string;
  estimation?: number;
  label?: string;
  milestone?: string;
}

interface HulyDocument {
  title: string;
  content: string;
  project?: string;
  assigner?: string;
}

interface ProjectInfo {
  _id: string;
  name: string;
  identifier: string;
  workspaceId?: string;
  kind?: string;
  defaultIssueStatus?: string;
}

class HulyClient {
  private ws: WebSocket | null = null;
  private config: HulyConfig;
  private connected: boolean = false;
  private projectCache: Map<string, ProjectInfo> = new Map();
  private token: string | null = null;
  private accountId: string | null = null;
  private pgPool: pg.Pool | null = null;
  private messageQueue: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();
  private messageCounter: number = 0;
  private apiClient: PlatformClient | null = null;

  constructor(config: HulyConfig) {
    this.config = config;
  }

  private async initApiClient(): Promise<PlatformClient> {
    if (this.apiClient) {
      return this.apiClient;
    }

    console.error('Initializing Huly API client...');
    this.apiClient = await connect(this.config.url, {
      email: this.config.email,
      password: this.config.password,
      workspace: this.config.workspace || 'Teaser Software',
      socketFactory: NodeWebSocketFactory,
      connectionTimeout: 30000,
    });
    console.error('Huly API client initialized');
    return this.apiClient;
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
    await this.initDatabase();
  }

  private async initDatabase(): Promise<void> {
    if (this.pgPool) return;

    this.pgPool = new pg.Pool({
      host: this.config.dbHost || 'cockroach',
      port: this.config.dbPort || 26257,
      user: this.config.dbUser || 'selfhost',
      password: this.config.dbPassword || '',
      database: this.config.dbName || 'defaultdb',
      ssl: false,
    });

    console.error('PostgreSQL pool initialized');
  }

  private async getWorkspaceToken(): Promise<string> {
    const baseUrl = this.config.url.replace(/\/$/, '');
    const accountUrl = `${baseUrl}/_accounts`;
    
    const loginPayload = {
      method: 'login',
      params: { email: this.config.email, password: this.config.password }
    };
    
    const loginResponse = await this.httpPost(accountUrl, loginPayload);
    if (loginResponse.error) {
      throw new Error(`Login failed: ${JSON.stringify(loginResponse.error)}`);
    }
    
    const loginResult = loginResponse.result as { token?: string; socialId?: string; account?: string } | undefined;
    if (!loginResult?.token) {
      throw new Error(`No token in login response`);
    }
    
    this.accountId = loginResult.socialId || loginResult.account || null;
    
    const workspaceName = this.config.workspace || 'Teaser Software';
    const selectPayload = {
      method: 'selectWorkspace',
      params: { workspaceUrl: workspaceName, kind: 'external' }
    };
    
    const selectResponse = await this.httpPost(accountUrl, selectPayload, loginResult.token);
    if (selectResponse.error) {
      throw new Error(`Workspace selection failed: ${JSON.stringify(selectResponse.error)}`);
    }
    
    const selectResult = selectResponse.result as { token?: string; socialId?: string } | undefined;
    const wsToken = selectResult?.token;
    if (!wsToken || typeof wsToken !== 'string') {
      throw new Error(`No workspace token in response`);
    }
    
    if (selectResult?.socialId) {
      this.accountId = selectResult.socialId;
    }
    
    return wsToken;
  }

  private async httpPost(url: string, body: Record<string, unknown>, token?: string): Promise<{ result?: Record<string, unknown>; error?: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
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
        console.error('WebSocket connected');
        resolve();
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        this.connected = false;
        this.ws = null;
        reject(new Error(`WebSocket error: ${error.message}`));
      });

      this.ws.on('close', () => {
        this.connected = false;
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.id && this.messageQueue.has(message.id)) {
            const { resolve } = this.messageQueue.get(message.id)!;
            this.messageQueue.delete(message.id);
            console.error(`WebSocket message received for ID ${message.id}:`, JSON.stringify(message, null, 2));
            resolve(message);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });
    });
  }

  async getProjectInfo(projectName: string): Promise<ProjectInfo> {
    if (this.projectCache.has(projectName)) {
      return this.projectCache.get(projectName)!;
    }

    const projects = await this.listProjects();
    const project = projects.find((p) => 
      p.name === projectName || p._id === projectName || p.identifier === projectName
    );

    if (!project) {
      throw new Error(`Project not found: ${projectName}. Available: ${projects.map(p => p.name).join(', ')}`);
    }

    let kind: string | undefined;
    let workspaceId: string | undefined;
    
    if (this.pgPool) {
      const result = await this.pgPool.query(
        'SELECT "workspaceId", data->>\'kind\' as kind FROM task WHERE space = $1 LIMIT 1',
        [project._id]
      );
      if (result.rows.length > 0) {
        workspaceId = result.rows[0].workspaceId;
        kind = result.rows[0].kind;
      }
    }
    
    if (!kind) {
      const issues = await this.listIssues(project._id);
      kind = issues.length > 0 ? issues[0].kind : undefined;
    }
    
    if (!kind && this.pgPool) {
      const docResult = await this.pgPool.query(
        'SELECT data->>\'kind\' as kind FROM document WHERE _id = $1 LIMIT 1',
        [project._id]
      );
      if (docResult.rows.length > 0 && docResult.rows[0].kind) {
        kind = docResult.rows[0].kind;
      }
    }
    
    if (!kind) {
      kind = (project as { kind?: string }).kind || '6976d5c8dfe597052a795607';
    }

    const info: ProjectInfo = {
      _id: project._id,
      name: project.name,
      identifier: project.identifier || '',
      workspaceId,
      kind,
      defaultIssueStatus: project.defaultIssueStatus || 'tracker:status:Backlog',
    };

    this.projectCache.set(projectName, info);
    return info;
  }

  async ensureWorkspaceId(spaceId: string): Promise<string | undefined> {
    if (!this.pgPool) {
      return undefined;
    }
    try {
      const result = await this.pgPool.query(
        'SELECT "workspaceId" FROM task WHERE space = $1 LIMIT 1',
        [spaceId]
      );
      if (result.rows.length > 0) {
        return result.rows[0].workspaceId;
      }
      const docResult = await this.pgPool.query(
        'SELECT "workspaceId" FROM document WHERE space = $1 LIMIT 1',
        [spaceId]
      );
      if (docResult.rows.length > 0) {
        return docResult.rows[0].workspaceId;
      }
    } catch (error) {
      console.error('Error getting workspaceId:', error);
    }
    return undefined;
  }

  async listLabelsFromDB(spaceId?: string, workspaceId?: string): Promise<Array<{ _id: string; name?: string; color?: string; space?: string; workspaceId?: string; _class?: string; table?: string }>> {
    if (!this.pgPool) {
      throw new Error('Database not initialized');
    }

    const allLabels: Array<{ _id: string; name?: string; color?: string; space?: string; workspaceId?: string; _class?: string; table?: string }> = [];

    const tableNames = ['label', 'labels', 'tracker_label', 'tracker_labels'];
    
    for (const tableName of tableNames) {
      try {
        let query = `SELECT _id, _class, space, "workspaceId", data FROM ${tableName}`;
        const params: string[] = [];
        const conditions: string[] = [];

        if (spaceId) {
          conditions.push('space = $' + (params.length + 1));
          params.push(spaceId);
        }
        if (workspaceId) {
          conditions.push('"workspaceId" = $' + (params.length + 1));
          params.push(workspaceId);
        }

        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' OR ');
        }

        query += ' ORDER BY _id LIMIT 100';

        const result = await this.pgPool.query(query, params);
        const labels = result.rows.map((row: { _id: string; _class?: string; space?: string; workspaceId?: string; data?: unknown }) => {
          const label: { _id: string; name?: string; color?: string; space?: string; workspaceId?: string; _class?: string; table?: string } = {
            _id: row._id,
            _class: row._class,
            space: row.space,
            workspaceId: row.workspaceId,
            table: tableName,
          };

          if (row.data && typeof row.data === 'object') {
            const data = row.data as Record<string, unknown>;
            if (data.label) {
              label.name = String(data.label);
            } else if (data.title) {
              label.name = String(data.title);
            } else if (data.name) {
              label.name = String(data.name);
            }
            if (data.color) {
              label.color = String(data.color);
            }
          }

          return label;
        });
        allLabels.push(...labels);
        console.error(`Found ${labels.length} labels in table: ${tableName}`);
      } catch (error) {
        console.error(`Table ${tableName} does not exist or error:`, error);
      }
    }

    if (allLabels.length === 0) {
      try {
        const tablesResult = await this.pgPool.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND (table_name LIKE '%label%' OR table_name LIKE '%tracker%')
          ORDER BY table_name
        `);
        console.error('Tables with "label" or "tracker" in name:', tablesResult.rows.map((r: { table_name: string }) => r.table_name));
      } catch (error) {
        console.error('Error listing tables:', error);
      }

      try {
        const classQuery = spaceId 
          ? 'SELECT _id, _class, space, "workspaceId", data FROM task WHERE _class LIKE $1 LIMIT 10'
          : 'SELECT _id, _class, space, "workspaceId", data FROM task WHERE _class LIKE $1 LIMIT 10';
        const classResult = await this.pgPool.query(classQuery, ['%Label%']);
        console.error(`Found ${classResult.rows.length} rows with Label in _class from task table`);
        if (classResult.rows.length > 0) {
          console.error('Sample row:', JSON.stringify(classResult.rows[0], null, 2));
        }
      } catch (error) {
        console.error('Error querying by _class:', error);
      }
    }

    return allLabels;
  }

  async exploreLabelsInDB(spaceId?: string, workspaceId?: string): Promise<{ tables: string[]; labels: Array<{ _id: string; name?: string; color?: string; space?: string; workspaceId?: string; _class?: string; table?: string; source?: string }>; info: string[] }> {
    if (!this.pgPool) {
      throw new Error('Database not initialized');
    }

    const info: string[] = [];
    const allLabels: Array<{ _id: string; name?: string; color?: string; space?: string; workspaceId?: string; _class?: string; table?: string; source?: string }> = [];
    const foundTables: string[] = [];

    try {
      const allTablesResult = await this.pgPool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `);
      const allTables = allTablesResult.rows.map((r: { table_name: string }) => r.table_name);
      info.push(`Total tables in database: ${allTables.length}`);
      
      const labelTables = allTables.filter((t: string) => t.toLowerCase().includes('label'));
      info.push(`Tables with 'label' in name: ${labelTables.join(', ') || 'none'}`);
      foundTables.push(...labelTables);

      for (const tableName of labelTables) {
        try {
          const query = `SELECT _id, _class, space, "workspaceId", data FROM ${tableName} LIMIT 50`;
          const result = await this.pgPool.query(query);
          info.push(`Table ${tableName}: ${result.rows.length} rows`);
          
          for (const row of result.rows) {
            const label: { _id: string; name?: string; color?: string; space?: string; workspaceId?: string; _class?: string; table?: string; source?: string } = {
              _id: row._id,
              _class: row._class,
              space: row.space,
              workspaceId: row.workspaceId,
              table: tableName,
              source: 'table',
            };

            if (row.data && typeof row.data === 'object') {
              const data = row.data as Record<string, unknown>;
              if (data.label) label.name = String(data.label);
              else if (data.title) label.name = String(data.title);
              else if (data.name) label.name = String(data.name);
              if (data.color) label.color = String(data.color);
            }
            allLabels.push(label);
          }
        } catch (error) {
          info.push(`Error querying ${tableName}: ${String(error)}`);
        }
      }

      const tablesToCheck = ['task', 'document', 'tx', 'activity'];
      for (const tableName of tablesToCheck) {
        try {
          const classQuery = `SELECT _id, _class, space, "workspaceId", data FROM ${tableName} WHERE _class LIKE $1 LIMIT 20`;
          const classResult = await this.pgPool.query(classQuery, ['%Label%']);
          if (classResult.rows.length > 0) {
            info.push(`Found ${classResult.rows.length} rows in ${tableName} with Label in _class`);
            for (const row of classResult.rows) {
              const label: { _id: string; name?: string; color?: string; space?: string; workspaceId?: string; _class?: string; table?: string; source?: string } = {
                _id: row._id,
                _class: row._class,
                space: row.space,
                workspaceId: row.workspaceId,
                table: tableName,
                source: '_class',
              };

              if (row.data && typeof row.data === 'object') {
                const data = row.data as Record<string, unknown>;
                if (data.label) label.name = String(data.label);
                else if (data.title) label.name = String(data.title);
                else if (data.name) label.name = String(data.name);
                if (data.color) label.color = String(data.color);
              }
              allLabels.push(label);
            }
          }
        } catch (error) {
          info.push(`Error querying ${tableName} for Label class: ${String(error)}`);
        }
      }

      try {
        const dataQuery = `SELECT _id, _class, space, "workspaceId", data FROM task WHERE data::text LIKE '%label%' LIMIT 20`;
        const dataResult = await this.pgPool.query(dataQuery);
        if (dataResult.rows.length > 0) {
          info.push(`Found ${dataResult.rows.length} rows in task with 'label' in data`);
        }
      } catch (error) {
        info.push(`Error querying task data for label: ${String(error)}`);
      }

    } catch (error) {
      info.push(`Error during exploration: ${String(error)}`);
    }

    return { tables: foundTables, labels: allLabels, info };
  }

  private plainTextToProseMirrorDoc(content: string): string {
    type Block = { type: string; content?: unknown[] };
    const blocks: Block[] = [];
    const lines = content.split(/\n/);
    let currentBullets: Block[] = [];

    const flushBullets = (): void => {
      if (currentBullets.length > 0) {
        blocks.push({ type: 'bulletList', content: currentBullets });
        currentBullets = [];
      }
    };

    const textNode = (text: string): { type: 'text'; text: string } => ({ type: 'text', text });
    const paragraph = (text: string): Block =>
      ({ type: 'paragraph', content: text ? [textNode(text)] : [] });
    const listItem = (text: string): Block =>
      ({ type: 'listItem', content: [{ type: 'paragraph', content: text ? [textNode(text)] : [] }] });

    for (const line of lines) {
      const trimmed = line.trim();
      const bulletMatch = trimmed.match(/^[-*]\s*(.*)$/);
      if (bulletMatch) {
        currentBullets.push(listItem(bulletMatch[1].trim()));
      } else {
        flushBullets();
        blocks.push(paragraph(trimmed));
      }
    }
    flushBullets();

    const doc = { type: 'doc', content: blocks };
    return JSON.stringify(doc);
  }

  private proseMirrorDocToPlainText(jsonStr: string): string {
    try {
      const doc = JSON.parse(jsonStr) as { content?: Array<{ type: string; content?: Array<{ type: string; text?: string; content?: unknown[] }> }> };
      if (!doc?.content) return '';
      const parts: string[] = [];
      for (const block of doc.content) {
        if (block.type === 'paragraph' && Array.isArray(block.content)) {
          const text = block.content.map((n) => (n.type === 'text' && n.text ? n.text : '')).join('');
          parts.push(text);
        } else if (block.type === 'bulletList' && Array.isArray(block.content)) {
          for (const item of block.content) {
            if (item.type === 'listItem' && Array.isArray(item.content)) {
              for (const p of item.content) {
                const pBlock = p as { type: string; content?: Array<{ text?: string }> };
                if (pBlock.type === 'paragraph' && Array.isArray(pBlock.content)) {
                  const text = pBlock.content.map((n) => n.text ?? '').join('');
                  parts.push(`- ${text}`);
                }
              }
            }
          }
        }
      }
      return parts.join('\n');
    } catch {
      return jsonStr;
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  private generateHash(data: string, id: string, timestamp: number): string {
    const hash = crypto.createHash('md5').update(data + id + timestamp.toString()).digest('hex');
    return hash.substring(0, 11);
  }

  private mapPriority(priority: string): number {
    const map: Record<string, number> = { urgent: 3, high: 2, medium: 1, low: 0 };
    return map[priority] || 0;
  }

  async findUserByName(name: string): Promise<string | null> {
    const normalizedName = name.trim();
    
    if (USER_MAPPING[normalizedName]) {
      console.error(`Found user in mapping: ${normalizedName} -> ${USER_MAPPING[normalizedName]}`);
      return USER_MAPPING[normalizedName];
    }
    
    const variations = [
      normalizedName,
      normalizedName.split(' ').reverse().join(' '),
      normalizedName.split(' ').reverse().join(', '),
      normalizedName.split(' ').map((n, i, arr) => i === 0 ? arr.slice(1).join(' ') + ',' + n : '').filter(Boolean).join(''),
    ];
    
    for (const variation of variations) {
      if (USER_MAPPING[variation]) {
        console.error(`Found user in mapping (variation): ${variation} -> ${USER_MAPPING[variation]}`);
        return USER_MAPPING[variation];
      }
    }
    
    console.error(`User not found in mapping: ${normalizedName}`);
    return null;
  }

  async findAssigneeByName(name: string): Promise<string | null> {
    const normalizedName = name.trim();
    
    if (ASSIGNEE_MAPPING[normalizedName]) {
      console.error(`Found assignee in mapping: ${normalizedName} -> ${ASSIGNEE_MAPPING[normalizedName]}`);
      return ASSIGNEE_MAPPING[normalizedName];
    }
    
    const variations = [
      normalizedName,
      normalizedName.split(' ').reverse().join(' '),
      normalizedName.split(' ').reverse().join(', '),
      normalizedName.split(' ').map((n, i, arr) => i === 0 ? arr.slice(1).join(' ') + ',' + n : '').filter(Boolean).join(''),
    ];
    
    for (const variation of variations) {
      if (ASSIGNEE_MAPPING[variation]) {
        console.error(`Found assignee in mapping (variation): ${variation} -> ${ASSIGNEE_MAPPING[variation]}`);
        return ASSIGNEE_MAPPING[variation];
      }
    }
    
    console.error(`Assignee not found in mapping: ${normalizedName}`);
    return null;
  }

  async createIssue(issue: HulyIssue): Promise<{ id: string; number: number; identifier: string }> {
    console.error('createIssue called with:', JSON.stringify(issue));
    
    if (!this.connected) {
      console.error('Not connected, connecting...');
      await this.connect();
    }

    if (!this.pgPool) {
      console.error('ERROR: Database not initialized');
      throw new Error('Database not initialized');
    }

    const project = await this.getProjectInfo(issue.project);
    console.error('Project info:', JSON.stringify(project));
    
    if (!project.workspaceId) {
      console.error('No workspaceId, querying...');
      let result = await this.pgPool.query(
        'SELECT "workspaceId" FROM task WHERE space = $1 LIMIT 1',
        [project._id]
      );
      if (result.rows.length > 0) {
        project.workspaceId = result.rows[0].workspaceId;
        console.error('Found workspaceId from task:', project.workspaceId);
      } else {
        result = await this.pgPool.query(
          'SELECT "workspaceId" FROM document WHERE space = $1 LIMIT 1',
          [project._id]
        );
        if (result.rows.length > 0) {
          project.workspaceId = result.rows[0].workspaceId;
          console.error('Found workspaceId from document:', project.workspaceId);
        } else {
          result = await this.pgPool.query(
            'SELECT "workspaceId" FROM task LIMIT 1',
          );
          if (result.rows.length > 0) {
            project.workspaceId = result.rows[0].workspaceId;
            console.error('Found workspaceId from any task:', project.workspaceId);
          } else {
            console.error('ERROR: No workspaceId found');
            throw new Error('Could not determine workspaceId. Create one issue or document manually first.');
          }
        }
      }
    }

    console.error('Listing issues to get next number...');
    const issues = await this.listIssues(project._id);
    console.error('Found issues:', issues.length);
    
    const maxNumber = issues.length > 0
      ? Math.max(...issues.map(i => {
          const match = i.identifier?.match(/-(\d+)$/);
          return match ? parseInt(match[1], 10) : 0;
        }))
      : 0;
    const sequence = maxNumber + 1;
    console.error('Next sequence:', sequence);
    
    const issueId = this.generateId();
    const identifier = `${project.identifier}-${sequence}`;
    const now = Date.now();
    
    const rankHex = sequence.toString(16).padStart(6, '0');
    const rank = `0|i${rankHex}:`;

    let assigneeId: string | null = null;
    if (issue.assignee) {
      assigneeId = await this.findAssigneeByName(issue.assignee);
      console.error('Assignee lookup:', issue.assignee, '->', assigneeId);
    }

    let creatorId = this.accountId || '1109002066808700929';
    if (issue.assigner) {
      const assignerId = await this.findUserByName(issue.assigner);
      if (assignerId) {
        creatorId = assignerId;
        console.error('Assigner lookup:', issue.assigner, '->', creatorId);
      }
    }


    let labelCount = 0;
    if (issue.label) {
      labelCount = 1;
    }

    let descriptionId: string = '';
    if (issue.description && issue.description.trim()) {
      try {
        const apiClient = await this.initApiClient();
        const markupRef = await apiClient.uploadMarkup(
          tracker.class.Issue,
          issueId as never,
          'description',
          issue.description,
          'markdown'
        );
        descriptionId = markupRef as string;
        console.error('Created description via API client:', descriptionId);
        
        try {
          await apiClient.close();
          this.apiClient = null;
        } catch {
        }
      } catch (err) {
        console.error('Failed to create description via API client:', err);
        descriptionId = '';
      }
    }

    const data: Record<string, unknown> = {
      title: issue.title,
      description: descriptionId || '',
      identifier,
      number: sequence,
      priority: this.mapPriority(issue.priority || 'medium'),
      status: project.defaultIssueStatus,
      kind: project.kind || 'tracker:taskTypes:Issue',
      estimation: 0,
      remainingTime: 0,
      reportedTime: 0,
      reports: 0,
      subIssues: 0,
      parents: [],
      childInfo: [],
      rank: rank,
      comments: 0,
      docUpdateMessages: 1,
      relations: [],
      labels: labelCount,
      attachedToClass: 'tracker:class:Project',
      collection: 'issues',
    };
    
    if (assigneeId) {
      data.assignee = assigneeId;
    }
    
    if (issue.milestone) {
      data.milestone = issue.milestone;
    }

    const dataJson = JSON.stringify(data);
    const hash = this.generateHash(dataJson, issueId, now);
    
    console.error('Creating issue via SQL...');
    
    await this.pgPool.query(
          `INSERT INTO task ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", "%hash%", data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            project.workspaceId,
            issueId,
            'tracker:class:Issue',
            project._id,
            creatorId,
            creatorId,
            now,
            now,
            project._id,
            hash,
            dataJson,
          ]
        );
        
        const txId = this.generateId();
        const txData = {
          attachedToClass: 'tracker:class:Project',
          attributes: data,
          collection: 'issues',
          objectClass: 'tracker:class:Issue',
        };
        const txHash = this.generateHash(JSON.stringify(txData), txId, now);
        
        await this.pgPool.query(
          `INSERT INTO tx ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", "%hash%", "objectSpace", "objectId", data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            project.workspaceId,
            txId,
            'core:class:TxCreateDoc',
            'core:space:Tx',
            creatorId,
            creatorId,
            now,
            now,
            project._id,
            txHash,
            project._id,
            issueId,
            JSON.stringify(txData),
          ]
        );
        
        const activityId = this.generateId();
        const activityData = {
          action: 'create',
          attachedToClass: 'tracker:class:Issue',
          collection: 'docUpdateMessages',
          objectClass: 'tracker:class:Issue',
          objectId: issueId,
          txId: txId,
          updateCollection: 'issues',
        };
        const activityHash = this.generateHash(JSON.stringify(activityData), activityId, now);
        
        await this.pgPool.query(
          `INSERT INTO activity ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", "%hash%", data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            project.workspaceId,
            activityId,
            'activity:class:DocUpdateMessage',
            project._id,
            creatorId,
            creatorId,
            now,
            now,
            issueId,
            activityHash,
            JSON.stringify(activityData),
          ]
        );
        
    console.error(`SUCCESS: Created issue ${identifier} in database`);
    
    if (issue.label && project.workspaceId) {
      await this.attachLabelToIssue(issueId, issue.label, project._id, project.workspaceId, creatorId, now);
    }

    return { id: issueId, number: sequence, identifier };
  }

  async updateIssue(identifier: string, updates: {
    estimation?: number;
    spentTime?: number;
    remainingTime?: number;
    status?: string;
    assignee?: string | null;
    title?: string;
    description?: string;
    priority?: 'urgent' | 'high' | 'medium' | 'low';
  }): Promise<{ id: string; identifier: string }> {
    console.error('updateIssue called with:', JSON.stringify({ identifier, updates }));

    if (!this.connected) {
      console.error('Not connected, connecting...');
      await this.connect();
    }

    if (!this.pgPool) {
      throw new Error('Database not initialized');
    }

    const result = await this.pgPool.query(
      'SELECT _id, data, "workspaceId", space FROM task WHERE data->>\'identifier\' = $1',
      [identifier]
    );

    if (result.rows.length === 0) {
      throw new Error(`Issue not found: ${identifier}`);
    }

    const task = result.rows[0];
    const issueId = task._id;
    const currentData = task.data as Record<string, unknown>;
    const now = Date.now();

    let assigneeId: string | null = null;
    if (updates.assignee) {
      assigneeId = await this.findAssigneeByName(updates.assignee);
      console.error('Assignee lookup:', updates.assignee, '->', assigneeId);
    }

    const updatedData: Record<string, unknown> = { ...currentData };
    const currentEstimation = (currentData.estimation as number) || 0;
    const currentSpentTime = (currentData.reportedTime as number) || 0;
    const currentRemainingTime = (currentData.remainingTime as number) || 0;

    if (updates.estimation !== undefined) {
      updatedData.estimation = updates.estimation;
      const spentTime = updates.spentTime !== undefined ? updates.spentTime : currentSpentTime;
      updatedData.remainingTime = updates.estimation - spentTime;
      console.error(`Updating estimation to ${updates.estimation} hours`);
    }

    if (updates.spentTime !== undefined) {
      updatedData.reportedTime = updates.spentTime;
      const estimation = updates.estimation !== undefined ? updates.estimation : currentEstimation;
      if (updates.remainingTime === undefined) {
        const calculatedRemaining = Math.max(0, estimation - updates.spentTime);
        updatedData.remainingTime = calculatedRemaining;
        console.error(`Updating spent time to ${updates.spentTime} hours, calculated remaining time: ${calculatedRemaining} hours (estimation: ${estimation} - spent: ${updates.spentTime})`);
      } else {
        console.error(`Updating spent time to ${updates.spentTime} hours, remaining time explicitly set to ${updates.remainingTime} hours`);
      }
    }

    if (updates.remainingTime !== undefined && updates.spentTime === undefined) {
      updatedData.remainingTime = updates.remainingTime;
      console.error(`Updating remaining time to ${updates.remainingTime} hours`);
    }

    if (updates.status) {
      updatedData.status = updates.status;
      console.error(`Updating status to ${updates.status}`);
    }

    if (assigneeId) {
      updatedData.assignee = assigneeId;
      console.error(`Updating assignee to ${assigneeId}`);
    } else if (updates.assignee === null) {
      updatedData.assignee = null;
      console.error('Removing assignee');
    }

    if (updates.title) {
      updatedData.title = updates.title;
      console.error(`Updating title to ${updates.title}`);
    }

    if (updates.description !== undefined) {
      updatedData.description = updates.description;
      console.error('Updating description');
    }

    if (updates.priority) {
      updatedData.priority = this.mapPriority(updates.priority);
      console.error(`Updating priority to ${updates.priority}`);
    }

    const dataJson = JSON.stringify(updatedData);
    const hash = this.generateHash(dataJson, issueId, now);

    const creatorId = this.accountId || '1109002066808700929';

    await this.pgPool.query(
      `UPDATE task SET data = $1, "%hash%" = $2, "modifiedOn" = $3, "modifiedBy" = $4 WHERE _id = $5`,
      [dataJson, hash, now, creatorId, issueId]
    );

    const txId = this.generateId();
    const txData = {
      attachedToClass: 'tracker:class:Project',
      attributes: updatedData,
      collection: 'issues',
      objectClass: 'tracker:class:Issue',
    };
    const txHash = this.generateHash(JSON.stringify(txData), txId, now);

    await this.pgPool.query(
      `INSERT INTO tx ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", "%hash%", "objectSpace", "objectId", data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        task.workspaceId,
        txId,
        'core:class:TxUpdateDoc',
        'core:space:Tx',
        creatorId,
        creatorId,
        now,
        now,
        'tracker:ids:NoParent',
        txHash,
        task.space,
        issueId,
        JSON.stringify(txData),
      ]
    );

    console.error(`SUCCESS: Updated issue ${identifier}`);

    return { id: issueId, identifier };
  }

  async deleteIssue(identifier: string): Promise<{ deleted: string }> {
    if (!this.connected) await this.connect();
    if (!this.pgPool) throw new Error('Database not initialized');

    const result = await this.pgPool.query(
      'SELECT _id, space, "workspaceId" FROM task WHERE data->>\'identifier\' = $1',
      [identifier]
    );
    if (result.rows.length === 0) {
      throw new Error(`Issue not found: ${identifier}`);
    }

    const task = result.rows[0] as { _id: string; space: string; workspaceId: string };
    const issueId = task._id;
    const projectId = task.space;
    const workspaceId = task.workspaceId;
    const now = Date.now();
    const creatorId = this.accountId || '1109002066808700929';

    const txId = this.generateId();
    const txData = {
      attachedToClass: 'tracker:class:Project',
      collection: 'issues',
      objectClass: 'tracker:class:Issue',
      objectId: issueId,
    };
    const txHash = this.generateHash(JSON.stringify(txData), txId, now);

    await this.pgPool.query(
      `INSERT INTO tx ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", "%hash%", "objectSpace", "objectId", data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        workspaceId,
        txId,
        'core:class:TxRemoveDoc',
        'core:space:Tx',
        creatorId,
        creatorId,
        now,
        now,
        projectId,
        txHash,
        projectId,
        issueId,
        JSON.stringify(txData),
      ]
    );

    const activityId = this.generateId();
    const activityData = {
      action: 'remove',
      attachedToClass: 'tracker:class:Project',
      collection: 'issues',
      objectClass: 'tracker:class:Issue',
      objectId: issueId,
      txId,
    };
    const activityHash = this.generateHash(JSON.stringify(activityData), activityId, now);

    await this.pgPool.query(
      `INSERT INTO activity ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", "%hash%", data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        workspaceId,
        activityId,
        'activity:class:DocRemoveMessage',
        projectId,
        creatorId,
        creatorId,
        now,
        now,
        projectId,
        activityHash,
        JSON.stringify(activityData),
      ]
    );

    await this.pgPool.query('DELETE FROM task WHERE _id = $1', [issueId]);

    console.error(`SUCCESS: Deleted issue ${identifier}`);
    return { deleted: identifier };
  }

  async addComment(identifier: string, content: string): Promise<{ id: string; identifier: string }> {
    if (!this.connected) await this.connect();
    if (!this.pgPool) throw new Error('Database not initialized');

    const result = await this.pgPool.query(
      'SELECT _id, data, space, "workspaceId" FROM task WHERE data->>\'identifier\' = $1',
      [identifier]
    );
    if (result.rows.length === 0) {
      throw new Error(`Issue not found: ${identifier}`);
    }

    const task = result.rows[0] as { _id: string; data: Record<string, unknown>; space: string; workspaceId: string };
    const issueId = task._id;
    const projectId = task.space;
    const workspaceId = task.workspaceId;
    const now = Date.now();
    const creatorId = this.accountId || '1109002066808700929';

    const activityId = this.generateId();
    const messageDoc = this.plainTextToProseMirrorDoc(content);
    const activityData = {
      attachedToClass: 'tracker:class:Issue',
      attachments: 0,
      collection: 'comments',
      message: messageDoc,
    };
    const activityHash = this.generateHash(JSON.stringify(activityData), activityId, now);

    await this.pgPool.query(
      `INSERT INTO activity ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", "%hash%", data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        workspaceId,
        activityId,
        'chunter:class:ChatMessage',
        projectId,
        creatorId,
        creatorId,
        now,
        now,
        issueId,
        activityHash,
        JSON.stringify(activityData),
      ]
    );

    const currentData = task.data as Record<string, unknown>;
    const commentsCount = ((currentData.comments as number) ?? 0) + 1;
    const updatedData = { ...currentData, comments: commentsCount };
    const dataJson = JSON.stringify(updatedData);
    const hash = this.generateHash(dataJson, issueId, now);

    await this.pgPool.query(
      `UPDATE task SET data = $1, "%hash%" = $2, "modifiedOn" = $3, "modifiedBy" = $4 WHERE _id = $5`,
      [dataJson, hash, now, creatorId, issueId]
    );

    console.error(`SUCCESS: Added comment to issue ${identifier}`);
    return { id: activityId, identifier };
  }

  async listComments(identifier: string): Promise<Array<{ id: string; message: string; createdOn: number }>> {
    if (!this.connected) await this.connect();
    if (!this.pgPool) throw new Error('Database not initialized');

    const taskResult = await this.pgPool.query(
      'SELECT _id FROM task WHERE data->>\'identifier\' = $1',
      [identifier]
    );
    if (taskResult.rows.length === 0) {
      throw new Error(`Issue not found: ${identifier}`);
    }
    const issueId = (taskResult.rows[0] as { _id: string })._id;

    const result = await this.pgPool.query(
      `SELECT _id, _class, data, "createdOn" FROM activity
       WHERE (data->>'srcDocId' = $1 AND _class = 'activity:class:ActivityReference')
          OR ("attachedTo" = $1 AND _class = 'chunter:class:ChatMessage')
       ORDER BY "createdOn" ASC`,
      [issueId]
    );

    return result.rows.map((row: { _id: string; _class?: string; data: Record<string, unknown>; createdOn: number }) => {
      const raw = row.data?.message;
      const message = row._class === 'chunter:class:ChatMessage' && typeof raw === 'string'
        ? this.proseMirrorDocToPlainText(raw)
        : (raw as string) ?? '';
      return { id: row._id, message, createdOn: row.createdOn };
    });
  }

  async deleteComment(commentId: string): Promise<{ deleted: string }> {
    if (!this.connected) await this.connect();
    if (!this.pgPool) throw new Error('Database not initialized');

    const getResult = await this.pgPool.query(
      'SELECT _class, data, "attachedTo" FROM activity WHERE _id = $1',
      [commentId]
    );
    if (getResult.rows.length === 0) {
      throw new Error(`Comment not found: ${commentId}`);
    }
    const row = getResult.rows[0] as { _class: string; data: Record<string, unknown>; attachedTo?: string };
    const issueId = row._class === 'chunter:class:ChatMessage'
      ? (row.attachedTo ?? '')
      : (row.data?.srcDocId as string) ?? '';
    if (!issueId) {
      throw new Error(`Comment ${commentId} has no issue reference`);
    }

    await this.pgPool.query('DELETE FROM activity WHERE _id = $1', [commentId]);

    const taskResult = await this.pgPool.query('SELECT data FROM task WHERE _id = $1', [issueId]);
    if (taskResult.rows.length > 0) {
      const currentData = taskResult.rows[0].data as Record<string, unknown>;
      const commentsCount = Math.max(0, ((currentData.comments as number) ?? 1) - 1);
      const updatedData = { ...currentData, comments: commentsCount };
      const now = Date.now();
      const creatorId = this.accountId || '1109002066808700929';
      const hash = this.generateHash(JSON.stringify(updatedData), issueId, now);
      await this.pgPool.query(
        `UPDATE task SET data = $1, "%hash%" = $2, "modifiedOn" = $3, "modifiedBy" = $4 WHERE _id = $5`,
        [JSON.stringify(updatedData), hash, now, creatorId, issueId]
      );
    }

    console.error(`SUCCESS: Deleted comment ${commentId}`);
    return { deleted: commentId };
  }

  async createDocument(doc: HulyDocument): Promise<{ id: string }> {
    console.error('createDocument called with:', JSON.stringify({ title: doc.title, contentLength: doc.content.length }));

    if (!this.connected) {
      console.error('Not connected, connecting...');
      await this.connect();
    }

    if (!this.pgPool) {
      console.error('ERROR: Database not initialized');
      throw new Error('Database not initialized');
    }

    let workspaceId: string | undefined;
    let spaceId: string | undefined;

    if (doc.project) {
      console.error('Getting project info...');
      const project = await this.getProjectInfo(doc.project);
      console.error('Project info:', JSON.stringify(project));
      spaceId = project._id;
      
      if (!project.workspaceId) {
        console.error('No workspaceId in project, querying...');
        const result = await this.pgPool!.query(
          'SELECT "workspaceId" FROM task WHERE space = $1 LIMIT 1',
          [project._id]
        );
        if (result.rows.length > 0) {
          workspaceId = result.rows[0].workspaceId;
          console.error('Found workspaceId:', workspaceId);
        } else {
          const docResult = await this.pgPool!.query(
            'SELECT "workspaceId" FROM document LIMIT 1',
          );
          if (docResult.rows.length > 0) {
            workspaceId = docResult.rows[0].workspaceId;
            console.error('Found workspaceId from document:', workspaceId);
          } else {
            throw new Error('Could not determine workspaceId. Create one issue or document manually first.');
          }
        }
      } else {
        workspaceId = project.workspaceId;
      }
    } else {
      if (this.pgPool) {
        const result = await this.pgPool.query(
          'SELECT "workspaceId" FROM document LIMIT 1',
        );
        if (result.rows.length > 0) {
          workspaceId = result.rows[0].workspaceId;
          console.error('Found workspaceId:', workspaceId);
        } else {
          console.error('ERROR: No workspaceId found');
          throw new Error('Could not determine workspaceId. Specify a project or create one document manually first.');
        }
      }
    }

    if (!workspaceId) {
      throw new Error('Could not determine workspaceId');
    }

    let assignerId: string | null = null;
    if (doc.assigner) {
      assignerId = await this.findUserByName(doc.assigner);
      console.error('Assigner lookup:', doc.assigner, '->', assignerId);
    }

    const creatorId = assignerId || this.accountId || '1109002067070353409';
    const documentId = this.generateId();
    const now = Date.now();
    const contentId = `${documentId}-content-${now}`;

    const data = {
      title: doc.title,
      content: contentId,
      attachments: 0,
      comments: 0,
      docUpdateMessages: 0,
      embeddings: 0,
      labels: 0,
      parent: 'document:ids:NoParent',
      rank: `0|${documentId.substring(0, 6)}:`,
      references: 0,
    };

    console.error('Inserting document into database...');
    try {
      await this.pgPool.query(
        `INSERT INTO document ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          workspaceId,
          documentId,
          'document:class:Document',
          spaceId || null,
          creatorId,
          creatorId,
          now,
          now,
          spaceId || null,
          JSON.stringify(data),
        ]
      );

      await this.pgPool.query(
        `INSERT INTO documents ("workspaceId", _id, _class, space, "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          workspaceId,
          contentId,
          'document:class:DocumentContent',
          spaceId || null,
          creatorId,
          creatorId,
          now,
          now,
          documentId,
          JSON.stringify({ content: doc.content }),
        ]
      );

      console.error(`SUCCESS: Created document ${doc.title} in database`);
    } catch (dbError) {
      console.error('DATABASE ERROR:', dbError);
      throw dbError;
    }

    return { id: documentId };
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
          if (response.result) {
            const result = response.result;
            if (Array.isArray(result)) {
              resolve(result);
            } else if (result.value && Array.isArray(result.value)) {
              resolve(result.value);
            } else if (result.docs && Array.isArray(result.docs)) {
              resolve(result.docs);
            } else {
              reject(new Error(`Unexpected format: ${JSON.stringify(result).substring(0, 200)}`));
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
          if (response.result) {
            const result = response.result;
            if (Array.isArray(result)) {
              resolve(result);
            } else if (result.value && Array.isArray(result.value)) {
              resolve(result.value);
            } else if (result.docs && Array.isArray(result.docs)) {
              resolve(result.docs);
            } else {
              reject(new Error(`Unexpected format: ${JSON.stringify(result).substring(0, 200)}`));
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

  async listStatuses(spaceId?: string): Promise<Array<{ _id: string; name?: string; category?: string }>> {
    if (!this.pgPool) {
      throw new Error('Database not initialized');
    }
    const params: string[] = [];
    const spaceCondition = spaceId ? ` AND space = $${params.length}` : '';
    if (spaceId) params.push(spaceId);

    try {
      let query = `SELECT _id, data->>'name' as name, data->>'category' as category FROM status WHERE 1=1${spaceCondition} ORDER BY data->>'rank' NULLS LAST, _id LIMIT 100`;
      const result = await this.pgPool.query(query, params);
      if (result.rows.length > 0) {
        return result.rows.map((row: { _id: string; name?: string; category?: string }) => ({
          _id: row._id,
          name: row.name ?? undefined,
          category: row.category ?? undefined,
        }));
      }
    } catch {
      //
    }

    try {
      const taskQuery = `SELECT _id, data->>'name' as name, data->>'category' as category FROM task WHERE _class LIKE '%Status%' AND data ? 'name'${spaceCondition} ORDER BY data->>'rank' NULLS LAST, _id LIMIT 100`;
      const taskResult = await this.pgPool.query(taskQuery, params);
      if (taskResult.rows.length > 0) {
        return taskResult.rows.map((row: { _id: string; name?: string; category?: string }) => ({
          _id: row._id,
          name: row.name ?? undefined,
          category: row.category ?? undefined,
        }));
      }
    } catch {
      //
    }

    try {
      const distinctResult = await this.pgPool.query(
        `SELECT DISTINCT data->>'status' as _id FROM task WHERE _class = 'tracker:class:Issue' AND data->>'status' IS NOT NULL AND data->>'status' != ''`
      );
      return distinctResult.rows.map((row: { _id: string }) => ({
        _id: row._id,
        name: row._id.replace(/^[^:]+:/, '') ?? undefined,
      }));
    } catch (error) {
      console.error('Error listing statuses:', error);
      return [];
    }
  }

  private async queryLabelsFromDB(): Promise<Array<{ _id: string; name?: string; color?: string }>> {
    if (!this.pgPool) {
      return [];
    }

    try {
      const result = await this.pgPool.query(`
        SELECT DISTINCT ON (data->>'title') 
          _id, 
          data->>'title' as title,
          data->>'color' as color,
          data->>'description' as description
        FROM tags 
        WHERE _class = 'tags:class:TagElement'
          AND space = 'core:space:Workspace'
          AND data->>'targetClass' = 'tracker:class:Issue'
        ORDER BY data->>'title', _id
        LIMIT 100
      `);

      return result.rows.map((row: { _id: string; title?: string; color?: string; description?: string }) => ({
        _id: row._id,
        name: row.title || undefined,
        color: row.color || undefined,
      }));
    } catch (error) {
      console.error('Error querying labels from DB:', error);
      return [];
    }
  }

  private async queryLabels(filter: Record<string, string>): Promise<Array<{ _id: string; name?: string; color?: string }>> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const listId = `list-labels-${Date.now()}-${++this.messageCounter}`;
      const listMessage = {
        id: listId,
        method: 'findAll',
        params: ['tags:class:TagElement', filter, { limit: 100 }],
      };
      console.error(`Querying labels with filter: ${JSON.stringify(filter)}`);

      const timeout = setTimeout(() => {
        this.messageQueue.delete(listId);
        resolve([]);
      }, 10000);

      this.messageQueue.set(listId, {
        resolve: (response: unknown) => {
          clearTimeout(timeout);
          try {
            const result = response as { result?: unknown; error?: unknown };
            
            if (result.error) {
              const errorStr = JSON.stringify(result.error);
              console.error(`Label query error: ${errorStr}`);
              if (errorStr === '{}' || errorStr === 'null' || errorStr === '""' || 
                  (typeof result.error === 'object' && result.error !== null && Object.keys(result.error).length === 0)) {
                console.error('Empty error, returning empty array');
                resolve([]);
                return;
              }
              console.error('Non-empty error, returning empty array');
              resolve([]);
              return;
            }
            if (result.result) {
              const data = result.result;
              let labels: Array<unknown> = [];
              if (Array.isArray(data)) {
                labels = data;
              } else if (typeof data === 'object' && data !== null) {
                const obj = data as { value?: unknown[]; docs?: unknown[] };
                if (Array.isArray(obj.value)) {
                  labels = obj.value;
                } else if (Array.isArray(obj.docs)) {
                  labels = obj.docs;
                }
              }
              console.error(`Parsed ${labels.length} labels from response`);
              
              resolve(labels.map((l: unknown) => {
                const label = l as Record<string, unknown>;
                const _id = label._id as string;
                
                let name: string | undefined;
                let color: string | undefined;
                
                if (label.label) {
                  name = label.label as string;
                } else if (label.title) {
                  name = label.title as string;
                } else if (label.name) {
                  name = label.name as string;
                } else if (label.data && typeof label.data === 'object') {
                  const data = label.data as Record<string, unknown>;
                  name = (data.label || data.title || data.name) as string | undefined;
                  color = data.color as string | undefined;
                }
                
                if (!color && label.color) {
                  color = label.color as string;
                }
                
                return {
                  _id,
                  name: name || 'Unnamed',
                  color,
                };
              }));
            } else {
              resolve([]);
            }
          } catch (error) {
            resolve([]);
          }
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          resolve([]);
        },
      });

      this.ws.send(JSON.stringify(listMessage));
    });
  }

  async listLabels(spaceId: string, workspaceId?: string): Promise<Array<{ _id: string; name?: string; color?: string }>> {
    console.error('Querying labels from database (tags table)...');
    const dbLabels = await this.queryLabelsFromDB();
    console.error(`Found ${dbLabels.length} labels from database`);
    
    if (dbLabels.length > 0) {
      return dbLabels;
    }

    if (!this.connected) {
      await this.connect();
    }

    const allLabels = new Map<string, { _id: string; name?: string; color?: string }>();

    console.error(`Querying workspace-level labels via WebSocket...`);
    const workspaceLabels = await this.queryLabels({ space: 'core:space:Workspace' });
    console.error(`Found ${workspaceLabels.length} workspace-level labels via WebSocket`);
    for (const label of workspaceLabels) {
      allLabels.set(label._id, label);
    }

    console.error(`Total unique labels found: ${allLabels.size}`);
    return Array.from(allLabels.values());
  }

  async createLabel(title: string, description?: string, color?: number): Promise<{ _id: string; name: string }> {
    if (!this.pgPool) {
      throw new Error('Database not initialized');
    }

    const labelId = this.generateId();
    const workspaceId = '460ced1c-6446-4a65-a344-7b8caa02365a';
    const now = Date.now();
    const creatorId = this.accountId || '1109002067077464065';
    const labelData = {
      category: 'tracker:category:Other',
      color: color || 15,
      description: description || '',
      refCount: 0,
      targetClass: 'tracker:class:Issue',
      title: title,
    };

    try {
      await this.pgPool.query(
        `INSERT INTO tags (_id, _class, space, "workspaceId", "modifiedBy", "createdBy", "modifiedOn", "createdOn", data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          labelId,
          'tags:class:TagElement',
          'core:space:Workspace',
          workspaceId,
          creatorId,
          creatorId,
          now,
          now,
          JSON.stringify(labelData),
        ]
      );

      console.error(`Created label: ${title} (ID: ${labelId})`);
      return { _id: labelId, name: title };
    } catch (error) {
      console.error('Error creating label:', error);
      throw error;
    }
  }

  private async attachLabelToIssue(issueId: string, labelId: string, spaceId: string, workspaceId: string, creatorId: string, timestamp: number): Promise<void> {
    if (!this.pgPool) {
      console.error('Database not initialized, cannot attach label');
      return;
    }

    try {
      const labelElement = await this.pgPool.query(
        'SELECT data FROM tags WHERE _id = $1 AND _class = $2',
        [labelId, 'tags:class:TagElement']
      );

      if (labelElement.rows.length === 0) {
        console.error(`Label ${labelId} not found`);
        return;
      }

      const labelData = labelElement.rows[0].data as Record<string, unknown>;
      const labelTitle = labelData.title as string;
      const labelColor = labelData.color as number;

      const tagRefId = this.generateId();
      const tagRefData = {
        attachedToClass: 'tracker:class:Issue',
        collection: 'labels',
        tag: labelId,
        title: labelTitle,
        color: labelColor,
      };

      await this.pgPool.query(
        `INSERT INTO tags (_id, _class, space, "workspaceId", "modifiedBy", "createdBy", "modifiedOn", "createdOn", "attachedTo", data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tagRefId,
          'tags:class:TagReference',
          spaceId,
          workspaceId,
          creatorId,
          creatorId,
          timestamp,
          timestamp,
          issueId,
          JSON.stringify(tagRefData),
        ]
      );

      console.error(`Attached label ${labelTitle} (${labelId}) to issue ${issueId}`);
    } catch (error) {
      console.error('Error attaching label to issue:', error);
    }
  }

  async queryTaskByIdentifier(identifier: string): Promise<{ task: unknown; labelRefs: unknown[] } | null> {
    if (!this.pgPool) {
      throw new Error('Database not initialized');
    }
    
    const result = await this.pgPool.query(
      `SELECT _id, space, "attachedTo", data::text as data_json
       FROM task 
       WHERE data->>'identifier' = $1 
       ORDER BY (data->>'number')::int DESC 
       LIMIT 1`,
      [identifier]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const taskRow = result.rows[0];
    let taskData: Record<string, unknown> = {};
    try {
      if (taskRow.data_json && typeof taskRow.data_json === 'string') {
        taskData = JSON.parse(taskRow.data_json);
      } else if (taskRow.data_json) {
        taskData = taskRow.data_json as Record<string, unknown>;
      }
    } catch (e) {
      console.error('Error parsing task data:', e);
      taskData = {};
    }
    
    const task = {
      _id: taskRow._id,
      space: taskRow.space,
      attachedTo: taskRow.attachedTo,
      data: taskData,
    };
    
    const labelRefs = await this.pgPool.query(
      `SELECT _id, data FROM tags WHERE "attachedTo" = $1 AND _class = 'tags:class:TagReference'`,
      [task._id]
    );
    
    return {
      task,
      labelRefs: labelRefs.rows,
    };
  }

  async listMilestones(spaceId: string): Promise<Array<{ _id: string; name?: string; targetDate?: number }>> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const listId = `list-milestones-${Date.now()}-${++this.messageCounter}`;
      const listMessage = {
        id: listId,
        method: 'findAll',
        params: ['tracker:class:Milestone', { space: spaceId }, { limit: 100 }],
      };

      const timeout = setTimeout(() => {
        this.messageQueue.delete(listId);
        reject(new Error('List milestones timeout'));
      }, 10000);

      this.messageQueue.set(listId, {
        resolve: (response: unknown) => {
          clearTimeout(timeout);
          try {
            const result = response as { result?: unknown; error?: unknown };
            if (result.error) {
              reject(new Error(`API error: ${JSON.stringify(result.error)}`));
              return;
            }
            if (result.result) {
              const data = result.result;
              let milestones: Array<unknown> = [];
              if (Array.isArray(data)) {
                milestones = data;
              } else if (typeof data === 'object' && data !== null) {
                const obj = data as { value?: unknown[]; docs?: unknown[] };
                if (Array.isArray(obj.value)) {
                  milestones = obj.value;
                } else if (Array.isArray(obj.docs)) {
                  milestones = obj.docs;
                }
              }
              
              const firstMilestone = milestones.length > 0 ? milestones[0] as Record<string, unknown> : null;
              if (firstMilestone) {
                const milestoneJson = JSON.stringify(firstMilestone, null, 2);
                const allKeys = Object.keys(firstMilestone);
                const debugContent = `Milestones found: ${milestones.length}\nKeys: ${allKeys.join(', ')}\n\nFull structure:\n${milestoneJson}`;
                try {
                  fs.writeFileSync('/tmp/milestone-debug.log', debugContent);
                  console.error('DEBUG: Milestone structure written to /tmp/milestone-debug.log');
                } catch (e) {
                  console.error('DEBUG: Failed to write log:', String(e));
                  try {
                    fs.writeFileSync('/opt/huly-mcp-server/milestone-debug.log', debugContent);
                    console.error('DEBUG: Written to /opt/huly-mcp-server/milestone-debug.log instead');
                  } catch (e2) {
                    console.error('DEBUG: Failed both locations:', String(e2));
                  }
                }
              } else {
                fs.writeFileSync('/tmp/milestone-debug.log', 'No milestones found in response');
              }
              
              const mapped = milestones.map((m: unknown) => {
                const milestone = m as Record<string, unknown>;
                const _id = milestone._id as string;
                
                let name: string | undefined;
                let targetDate: number | undefined;
                
                if (milestone.label) {
                  name = milestone.label as string;
                } else if (milestone.title) {
                  name = milestone.title as string;
                } else if (milestone.name) {
                  name = milestone.name as string;
                } else if (milestone.text) {
                  name = milestone.text as string;
                } else if (milestone.data) {
                  if (typeof milestone.data === 'string') {
                    try {
                      const parsed = JSON.parse(milestone.data as string);
                      if (typeof parsed === 'object' && parsed !== null) {
                        const data = parsed as Record<string, unknown>;
                        name = (data.title || data.name || data.label || data.text) as string | undefined;
                        targetDate = data.targetDate as number | undefined;
                      }
                    } catch {
                      // Not JSON
                    }
                  } else if (typeof milestone.data === 'object') {
                    const data = milestone.data as Record<string, unknown>;
                    name = (data.title || data.name || data.label || data.text) as string | undefined;
                    targetDate = data.targetDate as number | undefined;
                    
                    if (!name && data.data && typeof data.data === 'object') {
                      const nestedData = data.data as Record<string, unknown>;
                      name = (nestedData.title || nestedData.name || nestedData.label || nestedData.text) as string | undefined;
                      targetDate = nestedData.targetDate as number | undefined;
                    }
                  }
                }
                
                if (milestone.targetDate) {
                  targetDate = milestone.targetDate as number;
                } else if (milestone.dueDate) {
                  targetDate = milestone.dueDate as number;
                }
                
                if (!targetDate && milestone.data && typeof milestone.data === 'object') {
                  const data = milestone.data as Record<string, unknown>;
                  targetDate = (data.targetDate || data.dueDate) as number | undefined;
                }
                
                return {
                  _id,
                  name: name || 'Unnamed',
                  targetDate,
                };
              });
              
              resolve(mapped);
            } else {
              resolve([]);
            }
          } catch (error) {
            reject(error);
          }
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.ws.send(JSON.stringify(listMessage));
    });
  }
}

const server = new Server(
  { name: 'huly-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

let hulyClient: HulyClient | null = null;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'create_issue',
        description: 'Create a new issue in Huly workspace',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Issue title' },
            description: { type: 'string', description: 'Issue description' },
            priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'], description: 'Priority level' },
            project: { type: 'string', description: 'Project name or identifier' },
            assignee: { type: 'string', description: 'Assignee name (e.g. "Ha Nguyen")' },
            assigner: { type: 'string', description: 'Assigner/creator name (e.g. "Bach Duong")' },
            estimation: { type: 'number', description: 'Estimated hours to complete (optional - will be set to 0, dev agent should update later)' },
            label: { type: 'string', description: 'Label ID (from list_labels). Use label name to find ID.' },
            milestone: { type: 'string', description: 'Milestone ID (from list_milestones). Use milestone name to find ID.' },
          },
          required: ['title', 'project', 'description'],
        },
      },
      {
        name: 'delete_issue',
        description: 'Delete an issue from Huly workspace by identifier (e.g. KESOR-1).',
        inputSchema: {
          type: 'object',
          properties: {
            identifier: { type: 'string', description: 'Issue identifier (e.g. "KESOR-45")' },
          },
          required: ['identifier'],
        },
      },
      {
        name: 'update_issue',
        description: 'Update an existing issue in Huly workspace. Use this to update estimation, spent time, remaining time, status, assignee, title, description, or priority.',
        inputSchema: {
          type: 'object',
          properties: {
            identifier: { type: 'string', description: 'Issue identifier (e.g. "KESOR-45")' },
            estimation: { type: 'number', description: 'Estimated hours to complete' },
            spentTime: { type: 'number', description: 'Spent/reported time in hours' },
            remainingTime: { type: 'number', description: 'Remaining time in hours' },
            status: { type: 'string', description: 'Issue status (e.g. "tracker:status:InProgress", "tracker:status:Backlog")' },
            assignee: { type: 'string', description: 'Assignee name (e.g. "Ha Nguyen") or null to remove assignee' },
            title: { type: 'string', description: 'Issue title' },
            description: { type: 'string', description: 'Issue description' },
            priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'], description: 'Priority level' },
          },
          required: ['identifier'],
        },
      },
      {
        name: 'add_comment',
        description: 'Add a comment to an issue in Huly workspace. Newlines and bullet points (- or *) are rendered in Huly. Use for doc links, notes, or formatted messages.',
        inputSchema: {
          type: 'object',
          properties: {
            identifier: { type: 'string', description: 'Issue identifier (e.g. "KESOR-1")' },
            content: { type: 'string', description: 'Comment text; newlines and lines starting with - or * are rendered as paragraphs and bullet lists in Huly' },
          },
          required: ['identifier', 'content'],
        },
      },
      {
        name: 'list_comments',
        description: 'List comments on an issue. Returns comment id, message preview, and createdOn. Use comment id with delete_comment to remove.',
        inputSchema: {
          type: 'object',
          properties: {
            identifier: { type: 'string', description: 'Issue identifier (e.g. "KESOR-1")' },
          },
          required: ['identifier'],
        },
      },
      {
        name: 'delete_comment',
        description: 'Delete a comment from an issue. Use list_comments first to get the comment id.',
        inputSchema: {
          type: 'object',
          properties: {
            commentId: { type: 'string', description: 'Comment id from list_comments' },
          },
          required: ['commentId'],
        },
      },
      {
        name: 'list_issues',
        description: 'List issues from Huly',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Filter by project (optional)' },
          },
        },
      },
      {
        name: 'list_projects',
        description: 'List all projects in Huly',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_labels',
        description: 'List all labels in a project',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or identifier' },
          },
          required: ['project'],
        },
      },
      {
        name: 'list_milestones',
        description: 'List all milestones in a project',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or identifier' },
          },
          required: ['project'],
        },
      },
      {
        name: 'list_statuses',
        description: 'List all issue statuses in the workspace (use these _id values when updating issue status)',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or identifier (optional - filters by project space)' },
          },
          required: [],
        },
      },
      {
        name: 'list_labels_db',
        description: 'List all labels directly from the database (for debugging)',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or identifier (optional - will query all labels if not provided)' },
          },
          required: [],
        },
      },
      {
        name: 'explore_labels_db',
        description: 'Explore database to find where labels are stored (comprehensive search)',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project name or identifier (optional)' },
          },
          required: [],
        },
      },
      {
        name: 'create_document',
        description: 'Create a new document in Huly workspace',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Document title' },
            content: { type: 'string', description: 'Document content (markdown supported)' },
            project: { type: 'string', description: 'Project name or identifier (optional)' },
            assigner: { type: 'string', description: 'Assigner/creator name (e.g. "Bach Duong")' },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'create_label',
        description: 'Create a new label in the workspace',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Label name (e.g. "Documentation")' },
            description: { type: 'string', description: 'Label description (optional)' },
            color: { type: 'number', description: 'Color code (0-23, optional, default: 15)' },
          },
          required: ['title'],
        },
      },
      {
        name: 'query_task_db',
        description: 'Query task details from database by identifier (for debugging)',
        inputSchema: {
          type: 'object',
          properties: {
            identifier: { type: 'string', description: 'Task identifier (e.g. "KESOR-24")' },
          },
          required: ['identifier'],
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
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            const key = trimmed.substring(0, idx).trim();
            let value = trimmed.substring(idx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            if (key && value) process.env[key] = value;
          }
        }
      });
    }

    const config: HulyConfig = {
      url: process.env.HULY_URL || '',
      email: process.env.HULY_EMAIL || '',
      password: process.env.HULY_PASSWORD || '',
      workspace: process.env.HULY_WORKSPACE,
      dbHost: process.env.DB_HOST || 'cockroach',
      dbPort: parseInt(process.env.DB_PORT || '26257', 10),
      dbUser: process.env.DB_USER || 'selfhost',
      dbPassword: process.env.DB_PASSWORD || '',
      dbName: process.env.DB_NAME || 'defaultdb',
    };

    if (!config.url || !config.email || !config.password) {
      throw new Error('Missing required: HULY_URL, HULY_EMAIL, HULY_PASSWORD');
    }

    hulyClient = new HulyClient(config);
    await hulyClient.connect();
  }

  try {
    switch (name) {
      case 'create_issue': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const issue = args as unknown as HulyIssue;
        const result = await hulyClient.createIssue(issue);
        const details = [
          `✅ Created issue ${result.identifier}: ${issue.title}`,
          `ID: ${result.id}`,
        ];
        if (issue.assigner) details.push(`Assigner: ${issue.assigner}`);
        if (issue.assignee) details.push(`Assignee: ${issue.assignee}`);
        return {
          content: [{
            type: 'text',
            text: details.join('\n'),
          }],
        };
      }

      case 'delete_issue': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const deleteArgs = args as { identifier: string };
        if (!deleteArgs.identifier) throw new Error('identifier is required');
        const deleted = await hulyClient.deleteIssue(deleteArgs.identifier);
        return {
          content: [{
            type: 'text',
            text: `✅ Deleted issue ${deleted.deleted}`,
          }],
        };
      }

      case 'update_issue': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const updateArgs = args as { identifier: string; estimation?: number; spentTime?: number; remainingTime?: number; status?: string; assignee?: string | null; title?: string; description?: string; priority?: 'urgent' | 'high' | 'medium' | 'low' };
        if (!updateArgs.identifier) throw new Error('identifier is required');
        const result = await hulyClient.updateIssue(updateArgs.identifier, {
          estimation: updateArgs.estimation,
          spentTime: updateArgs.spentTime,
          remainingTime: updateArgs.remainingTime,
          status: updateArgs.status,
          assignee: updateArgs.assignee === null ? null : updateArgs.assignee,
          title: updateArgs.title,
          description: updateArgs.description,
          priority: updateArgs.priority,
        });
        const details = [`✅ Updated issue ${result.identifier}`];
        if (updateArgs.estimation !== undefined) details.push(`Estimation: ${updateArgs.estimation}h`);
        if (updateArgs.spentTime !== undefined) details.push(`Spent Time: ${updateArgs.spentTime}h`);
        if (updateArgs.remainingTime !== undefined) details.push(`Remaining Time: ${updateArgs.remainingTime}h`);
        if (updateArgs.status) details.push(`Status: ${updateArgs.status}`);
        if (updateArgs.assignee !== undefined) details.push(`Assignee: ${updateArgs.assignee || 'removed'}`);
        if (updateArgs.title) details.push(`Title: ${updateArgs.title}`);
        if (updateArgs.priority) details.push(`Priority: ${updateArgs.priority}`);
        return {
          content: [{
            type: 'text',
            text: details.join('\n'),
          }],
        };
      }

      case 'add_comment': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const commentArgs = args as { identifier: string; content: string };
        if (!commentArgs.identifier || typeof commentArgs.content !== 'string') {
          throw new Error('identifier and content are required');
        }
        const result = await hulyClient.addComment(commentArgs.identifier, commentArgs.content);
        return {
          content: [{
            type: 'text',
            text: `Added comment to issue ${result.identifier}`,
          }],
        };
      }

      case 'list_comments': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const listArgs = args as { identifier: string };
        if (!listArgs.identifier) throw new Error('identifier is required');
        const comments = await hulyClient.listComments(listArgs.identifier);
        const lines = comments.map((c, i) => `${i + 1}. id=${c.id} createdOn=${c.createdOn}\n   ${(c.message || '').slice(0, 80)}...`);
        return {
          content: [{
            type: 'text',
            text: comments.length === 0 ? `No comments on ${listArgs.identifier}` : `Comments on ${listArgs.identifier}:\n\n${lines.join('\n\n')}`,
          }],
        };
      }

      case 'delete_comment': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const delArgs = args as { commentId: string };
        if (!delArgs.commentId) throw new Error('commentId is required');
        const result = await hulyClient.deleteComment(delArgs.commentId);
        return {
          content: [{
            type: 'text',
            text: `Deleted comment ${result.deleted}`,
          }],
        };
      }

      case 'list_issues': {
        const project = (args as { project?: string })?.project;
        let spaceId: string | undefined;
        if (project) {
          const info = await hulyClient.getProjectInfo(project);
          spaceId = info._id;
        }
        const issues = await hulyClient.listIssues(spaceId);
        return {
          content: [{
            type: 'text',
            text: `Found ${issues.length} issues:\n\n${issues.map(i => `- ${i.identifier || i._id}: ${i.title}`).join('\n')}`,
          }],
        };
      }

      case 'list_projects': {
        const projects = await hulyClient.listProjects();
        return {
          content: [{
            type: 'text',
            text: `Found ${projects.length} projects:\n\n${projects.map(p => `- ${p.identifier || p._id}: ${p.name}`).join('\n')}`,
          }],
        };
      }

      case 'create_document': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const doc = args as unknown as HulyDocument;
        const result = await hulyClient.createDocument(doc);
        const details = [
          `✅ Created document: ${doc.title}`,
          `ID: ${result.id}`,
        ];
        if (doc.assigner) details.push(`Assigner: ${doc.assigner}`);
        if (doc.project) details.push(`Project: ${doc.project}`);
        return {
          content: [{
            type: 'text',
            text: details.join('\n'),
          }],
        };
      }

      case 'create_label': {
        if (!args || typeof args !== 'object') throw new Error('Invalid arguments');
        const labelArgs = args as { title: string; description?: string; color?: number };
        if (!labelArgs.title) throw new Error('Label title is required');
        try {
          const result = await hulyClient.createLabel(
            labelArgs.title,
            labelArgs.description,
            labelArgs.color
          );
          return {
            content: [{
              type: 'text',
              text: `✅ Created label: ${result.name}\nID: ${result._id}`,
            }],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to create label: ${errorMsg}`);
        }
      }

      case 'list_labels': {
        const project = (args as { project: string })?.project;
        if (!project) throw new Error('Project is required');
        try {
          const projectInfo = await hulyClient.getProjectInfo(project);
          let workspaceId = projectInfo.workspaceId;
          if (!workspaceId) {
            workspaceId = await hulyClient.ensureWorkspaceId(projectInfo._id);
          }
          const labels = await hulyClient.listLabels(projectInfo._id, workspaceId);
          if (labels.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No labels found in this project or workspace (v2 - spaceId: ${projectInfo._id}, workspaceId: ${workspaceId || 'none'}). Labels may not be accessible via this API.`,
              }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: `Found ${labels.length} labels:\n\n${labels.map(l => `- ${l.name || 'Unnamed'} (ID: ${l._id})${l.color ? ` [Color: ${l.color}]` : ''}`).join('\n')}`,
            }],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('API error: {}') || errorMsg.includes('API error')) {
            return {
              content: [{
                type: 'text',
                text: 'Labels are not accessible via the WebSocket API. They may be workspace-level. You can create labels manually in Huly or they may need to be accessed differently.',
              }],
            };
          }
          throw error;
        }
      }

      case 'list_milestones': {
        const project = (args as { project: string })?.project;
        if (!project) throw new Error('Project is required');
                const projectInfo = await hulyClient.getProjectInfo(project);
                const milestones = await hulyClient.listMilestones(projectInfo._id);
                if (milestones.length === 0) {
                  return {
                    content: [{
                      type: 'text',
                      text: 'No milestones found in this project.',
                    }],
                  };
                }
                const milestoneList = milestones.map(m => {
                  const name = m.name || 'Unnamed';
                  const targetInfo = m.targetDate ? ` [Target: ${new Date(m.targetDate).toLocaleDateString()}]` : '';
                  return `- ${name} (ID: ${m._id})${targetInfo}`;
                }).join('\n');
                
                return {
                  content: [{
                    type: 'text',
                    text: `Found ${milestones.length} milestones:\n\n${milestoneList}\n\nNote: If names show as "Unnamed", the milestone structure may need debugging. Milestone IDs are correct and can be used.`,
                  }],
                };
      }

      case 'list_statuses': {
        const project = (args as { project?: string })?.project;
        let spaceId: string | undefined;
        if (project) {
          const projectInfo = await hulyClient.getProjectInfo(project);
          spaceId = projectInfo._id;
        }
        const statuses = await hulyClient.listStatuses(spaceId);
        if (statuses.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No statuses found. The status table may use different column names.',
            }],
          };
        }
        const statusList = statuses.map(s => `- ${s.name ?? s._id} (ID: ${s._id})`).join('\n');
        return {
          content: [{
            type: 'text',
            text: `Found ${statuses.length} statuses:\n\n${statusList}\n\nUse the ID when calling update_issue with status.`,
          }],
        };
      }

      case 'list_labels_db': {
        const project = (args as { project?: string })?.project;
        try {
          let spaceId: string | undefined;
          let workspaceId: string | undefined;

          if (project) {
            const projectInfo = await hulyClient.getProjectInfo(project);
            spaceId = projectInfo._id;
            workspaceId = projectInfo.workspaceId;
            if (!workspaceId) {
              workspaceId = await hulyClient.ensureWorkspaceId(projectInfo._id);
            }
          }

          const labels = await hulyClient.listLabelsFromDB(spaceId, workspaceId);
          
          if (labels.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No labels found in database${project ? ` for project: ${project}` : ''}${spaceId ? ` (spaceId: ${spaceId})` : ''}${workspaceId ? ` (workspaceId: ${workspaceId})` : ''}.`,
              }],
            };
          }

          const labelList = labels.map(l => {
            const parts = [`- ${l.name || 'Unnamed'} (ID: ${l._id})`];
            if (l.color) parts.push(`Color: ${l.color}`);
            if (l.space) parts.push(`Space: ${l.space}`);
            if (l.workspaceId) parts.push(`Workspace: ${l.workspaceId}`);
            if (l._class) parts.push(`Class: ${l._class}`);
            return parts.join(' | ');
          }).join('\n');

          return {
            content: [{
              type: 'text',
              text: `Found ${labels.length} labels in database${project ? ` for project: ${project}` : ''}:\n\n${labelList}`,
            }],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            content: [{
              type: 'text',
              text: `Error querying labels from database: ${errorMsg}`,
            }],
          };
        }
      }

      case 'explore_labels_db': {
        const project = (args as { project?: string })?.project;
        try {
          let spaceId: string | undefined;
          let workspaceId: string | undefined;

          if (project) {
            const projectInfo = await hulyClient.getProjectInfo(project);
            spaceId = projectInfo._id;
            workspaceId = projectInfo.workspaceId;
            if (!workspaceId) {
              workspaceId = await hulyClient.ensureWorkspaceId(projectInfo._id);
            }
          }

          const result = await hulyClient.exploreLabelsInDB(spaceId, workspaceId);
          
          const output: string[] = [];
          output.push('=== Database Exploration Results ===');
          output.push('');
          output.push('Information:');
          result.info.forEach(info => output.push(`  - ${info}`));
          output.push('');
          output.push(`Tables found: ${result.tables.length > 0 ? result.tables.join(', ') : 'none'}`);
          output.push('');
          output.push(`Labels found: ${result.labels.length}`);
          
          if (result.labels.length > 0) {
            output.push('');
            output.push('Labels:');
            result.labels.forEach(l => {
              const parts = [`  - ${l.name || 'Unnamed'} (ID: ${l._id})`];
              if (l.color) parts.push(`Color: ${l.color}`);
              if (l.space) parts.push(`Space: ${l.space}`);
              if (l.workspaceId) parts.push(`Workspace: ${l.workspaceId}`);
              if (l._class) parts.push(`Class: ${l._class}`);
              if (l.table) parts.push(`Table: ${l.table}`);
              if (l.source) parts.push(`Source: ${l.source}`);
              output.push(parts.join(' | '));
            });
          }

          return {
            content: [{
              type: 'text',
              text: output.join('\n'),
            }],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            content: [{
              type: 'text',
              text: `Error exploring database for labels: ${errorMsg}`,
            }],
          };
        }
      }

      case 'query_task_db': {
        const identifier = (args as { identifier: string })?.identifier;
        if (!identifier) throw new Error('Identifier is required');
        try {
          const result = await hulyClient.queryTaskByIdentifier(identifier);
          
          if (!result) {
            return {
              content: [{
                type: 'text',
                text: `Task ${identifier} not found in database.`,
              }],
            };
          }
          
          const task = result.task as { _id: string; space: string; attachedTo: string; data: Record<string, unknown> };
          const data = task.data || {};
          
          const parentFields: Record<string, unknown> = {
            attachedTo: String(task.attachedTo || ''),
            space: String(task.space || ''),
          };
          
          if (data.parent !== undefined) parentFields.parent = data.parent;
          if (data.parents !== undefined) parentFields.parents = data.parents;
          if (data.attachedToClass !== undefined) parentFields.attachedToClass = data.attachedToClass;
          if (data.collection !== undefined) parentFields.collection = data.collection;
          
          let jsonOutput: string;
          try {
            jsonOutput = JSON.stringify(parentFields, null, 2);
          } catch (e) {
            jsonOutput = `Error stringifying: ${e instanceof Error ? e.message : String(e)}`;
          }
          
          return {
            content: [{
              type: 'text',
              text: `Task: ${identifier}\n\nParent-Related Fields:\n${jsonOutput}`,
            }],
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : 'N/A';
          console.error('Query task error:', errorMsg, error);
          return {
            content: [{
              type: 'text',
              text: `Error querying task: ${errorMsg}\n\nStack: ${errorStack}`,
            }],
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('MCP Error:', msg);
    return { content: [{ type: 'text', text: `❌ Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Huly MCP Server running on stdio');
}

main().catch(console.error);
