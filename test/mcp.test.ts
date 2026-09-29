import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AstpackMcpServer, ErrorCode, PROTOCOL_VERSIONS, serveStdio } from '../src/mcp/server.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function setup() {
  const t = await makeTree({
    'src/a.ts': 'export function a(x: number): number {\n  return x * 2;\n}\n',
    'src/b.py': 'def b():\n    """Docs."""\n    return 1\n',
    'README.md': '# Demo\n',
  });
  cleanups.push(t.cleanup);
  return { root: t.root, server: new AstpackMcpServer({ roots: [t.root] }) };
}

let nextId = 1;
async function call(server: AstpackMcpServer, method: string, params?: Record<string, unknown>) {
  const response = await server.handle({ jsonrpc: '2.0', id: nextId++, method, params });
  return response as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

async function tool(server: AstpackMcpServer, name: string, args: Record<string, unknown>) {
  const res = await call(server, 'tools/call', { name, arguments: args });
  return res.result as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
}

describe('MCP server', () => {
  it('negotiates the protocol version', async () => {
    const { server } = await setup();
    const res = await call(server, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(res.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'astpack' }, capabilities: { tools: {} } });
    const unknown = await call(server, 'initialize', { protocolVersion: '1999-01-01' });
    expect(unknown.result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('lists read-only tools with JSON schemas', async () => {
    const { server } = await setup();
    const { tools } = (await call(server, 'tools/list')).result as { tools: { name: string; inputSchema: { required: string[] }; annotations: object }[] };
    expect(tools.map((t) => t.name)).toEqual(['pack_codebase', 'estimate_tokens', 'skeleton_file']);
    for (const t of tools) {
      expect(t.inputSchema.required).toEqual(['path']);
      expect(t.annotations).toMatchObject({ readOnlyHint: true });
    }
  });

  it('packs a codebase with focus', async () => {
    const { root, server } = await setup();
    const res = await tool(server, 'pack_codebase', { path: root, focus: ['src/a.ts'] });
    expect(res.isError).toBeUndefined();
    const text = res.content[0]!.text;
    expect(text).toContain('### `src/a.ts` [focus]');
    expect(text).toContain('return x * 2;');
    expect(text).toContain('def b():\n    """Docs."""\n    ...');
    expect(res.structuredContent).toMatchObject({ files: 3 });
  });

  it('supports xml format and token budgets', async () => {
    const { server } = await setup();
    const res = await tool(server, 'pack_codebase', { path: '.', format: 'xml', maxTokens: 100_000 });
    expect(res.content[0]!.text).toMatch(/^<project /);
  });

  it('estimates tokens without returning the document', async () => {
    const { root, server } = await setup();
    const res = await tool(server, 'estimate_tokens', { path: root, top: 2 });
    expect(res.content[0]!.text).toContain('Tokens (cl100k_base):');
    expect((res.structuredContent!.largest as unknown[]).length).toBe(2);
  });

  it('returns the skeleton of a single file', async () => {
    const { root, server } = await setup();
    const res = await tool(server, 'skeleton_file', { path: join(root, 'src/a.ts') });
    expect(res.content[0]!.text).toBe('export function a(x: number): number { /* ... */ }\n');
    expect(res.structuredContent).toMatchObject({ language: 'typescript', strategy: 'skeleton' });
  });

  it('refuses paths outside the allowed roots', async () => {
    const { server } = await setup();
    const res = await tool(server, 'skeleton_file', { path: '/etc/passwd' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('outside the allowed roots');
    const escape = await tool(server, 'pack_codebase', { path: '../..' });
    expect(escape.isError).toBe(true);
  });

  it('reports protocol errors', async () => {
    const { server } = await setup();
    expect((await call(server, 'nope')).error?.code).toBe(ErrorCode.MethodNotFound);
    expect((await call(server, 'tools/call', { name: 'missing' })).error?.code).toBe(ErrorCode.InvalidParams);
    expect((await call(server, 'tools/call', { name: 'pack_codebase', arguments: {} })).error?.message).toContain('"path" is required');
    expect((await call(server, 'tools/call', { name: 'pack_codebase', arguments: { path: '.', mode: 'x' } })).error?.code).toBe(
      ErrorCode.InvalidParams,
    );
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(await server.handle({ nope: true })).toMatchObject({ error: { code: ErrorCode.InvalidRequest } });
    expect((await call(server, 'ping')).result).toEqual({});
  });

  it('speaks newline-delimited JSON-RPC over stdio', async () => {
    const { server } = await setup();
    const input = new PassThrough();
    const output = new PassThrough();
    let received = '';
    output.on('data', (chunk) => (received += chunk.toString()));
    const done = serveStdio(server, input, output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write('not json\n');
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}`);
    await done;
    const messages = received.trim().split('\n').map((l) => JSON.parse(l));
    expect(messages).toHaveLength(3);
    expect(messages.find((m) => m.id === 1).result.protocolVersion).toBe('2025-06-18');
    expect(messages.find((m) => m.id === null).error.code).toBe(ErrorCode.ParseError);
    expect(messages.find((m) => m.id === 2).result.tools).toHaveLength(3);
  });
});
