// Read-only Salesforce MCP server. Wraps the existing bin/{prod,scratch}-{query,describe}.sh
// shell scripts so agents (currently: the Execution scout) can ask Salesforce
// questions through tool calls instead of Bash invocations.
//
// Two tools, each takes an optional `alias`:
//   - `alias` provided  → reads against prod (i.e. the client's Dev Hub) via the prod-* scripts
//   - `alias` omitted   → reads against the project's default target-org (the scratch) via the scratch-* scripts
//
// Read-only by construction: the underlying scripts only call `sf data query`
// and `sf sobject describe`. There is no path through this server that performs
// DML, deploys, or anonymous Apex.
//
// Transport: stdio. Spawned by the agent SDK as a subprocess. NEVER write to
// stdout from this file outside of the MCP SDK — stdout is the protocol channel.
// Logging goes to stderr via console.error.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BIN = (name: string) => resolve(REPO_ROOT, 'bin', name);

interface RunResult {
  ok: boolean;
  text: string;
}

async function runScript(script: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync('bash', [BIN(script), ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, text: stdout };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.stdout?.trim() || e.message || 'unknown error';
    return {
      ok: false,
      text: `${script} failed:\n${detail}`,
    };
  }
}

const server = new McpServer({
  name: 'sf-read',
  version: '0.1.0',
});

server.tool(
  'soqlQuery',
  'Run a read-only SOQL SELECT against a Salesforce org. Pass `alias` for prod (the client Dev Hub); omit to query the project default target-org (the scratch in pipeline context). Returns slim JSON: { totalSize, done, records[] } with internal `attributes` blocks stripped. SELECT only — DML and aggregate-update queries are not supported.',
  {
    soql: z.string().min(1).describe('A SOQL SELECT query.'),
    alias: z
      .string()
      .optional()
      .describe(
        'Org alias to target. Provide for prod (the client Dev Hub); omit to use the project default target-org (the scratch).',
      ),
  },
  async ({ soql, alias }) => {
    const result = alias
      ? await runScript('prod-query.sh', [alias, soql])
      : await runScript('scratch-query.sh', [soql]);
    return {
      content: [{ type: 'text', text: result.text }],
      isError: !result.ok,
    };
  },
);

server.tool(
  'describeSObject',
  'Describe a Salesforce SObject. Pass `alias` for prod (the client Dev Hub); omit to describe in the project default target-org (the scratch). Returns slim JSON: { name, label, custom, fields[] } where each field includes name, label, type, custom flag, nillable, optional referenceTo, and picklist values when relevant.',
  {
    sobject: z.string().min(1).describe('SObject API name (e.g. Account, Opportunity__c).'),
    alias: z
      .string()
      .optional()
      .describe(
        'Org alias to target. Provide for prod (the client Dev Hub); omit to use the project default target-org (the scratch).',
      ),
  },
  async ({ sobject, alias }) => {
    const result = alias
      ? await runScript('prod-describe.sh', [alias, sobject])
      : await runScript('scratch-describe.sh', [sobject]);
    return {
      content: [{ type: 'text', text: result.text }],
      isError: !result.ok,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[sf-read-mcp] connected');
