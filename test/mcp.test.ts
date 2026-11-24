import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isReportId, kinds, openStore } from '../src/store.ts';

const entry = fileURLToPath(new URL('../src/mcp.ts', import.meta.url));
const request = (id: string | number, method: string, params?: object) => ({ jsonrpc: '2.0', id, method, params });
const initialize = (protocolVersion = '2025-11-25') => request(1, 'initialize', {
  protocolVersion, capabilities: {}, clientInfo: { name: 'papercuts-test', version: '1' },
});
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id: number, args: unknown) => request(id, 'tools/call', { name: 'report_papercut', arguments: args });
const example = { tool: 'Example tool', kind: 'confusing', summary: 'Synthetic report summary' };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

async function temporaryDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'papercuts-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exchange(dir: string, ...frames: (string | Buffer)[]) {
  const child = spawn(process.execPath, [entry], {
    cwd: tmpdir(),
    env: { ...process.env, PAPERCUTS_DATA_DIR: dir, NODE_NO_WARNINGS: '1' },
    stdio: 'pipe',
    timeout: 15_000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const [[code, signal]] = await Promise.all([once(child, 'close'), pipeline(Readable.from(frames), child.stdin)]);
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '', 'MCP requests should not log to stderr');
  assert.ok(stdout.endsWith('\n'), 'each response is newline-terminated');
  const replies = stdout.trimEnd().split('\n').map(text => JSON.parse(text));
  for (const reply of replies) assert.equal(reply.jsonrpc, '2.0');
  return replies;
}

test('MCP negotiates a supported version and discovers exactly one tool after initialization', async t => {
  const dir = await temporaryDir(t);
  const replies = await exchange(dir, ...[
    request(0, 'ping'), request('early', 'tools/list'), initialize('2025-06-18'), initialized,
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'earlier' } },
    request('discovery', 'tools/list'), request(2, 'no/such/method'),
  ].map(line));
  assert.deepEqual(replies.map(r => r.id), [0, 'early', 1, 'discovery', 2]);
  assert.deepEqual(replies[0].result, {});
  assert.equal(replies[1].error.code, -32000);
  assert.equal(replies[2].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies[2].result.capabilities, { tools: {} });
  assert.equal(replies[2].result.serverInfo.name, 'papercuts');
  const tools = replies[3].result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'report_papercut');
  assert.deepEqual(tools[0].inputSchema.required, ['tool', 'kind', 'summary']);
  assert.deepEqual(tools[0].inputSchema.properties.kind.enum, kinds);
  assert.equal(replies[4].error.code, -32601);
  await assert.rejects(access(join(dir, 'reports.sqlite')), { code: 'ENOENT' });
});

test('MCP falls back to its preferred version and recovers from malformed or oversized frames', async t => {
  const dir = await temporaryDir(t);
  const replies = await exchange(dir,
    '{not json}\n', Buffer.from([0xff, 0x0a]), ' '.repeat(70_000), '\n',
    line({ jsonrpc: '2.0', id: null, method: 'ping' }),
    line(request(0, 'initialize', {})), line(initialize('2099-01-01')), `${JSON.stringify(initialized)}\r\n`,
    line(request(2, 'tools/call', { name: 'does_not_exist' })),
    JSON.stringify(request(3, 'ping')),
  );
  assert.deepEqual(replies.map(r => r.id), [null, null, null, null, 0, 1, 2, 3]);
  assert.deepEqual(replies.slice(0, 5).map(r => r.error.code), [-32700, -32700, -32700, -32600, -32602]);
  assert.equal(replies[5].result.protocolVersion, '2025-11-25');
  assert.equal(replies[6].error.code, -32602);
  assert.deepEqual(replies[7].result, {});
});

test('MCP validates arguments without echoing or storing rejected data', async t => {
  const dir = await temporaryDir(t);
  const bad = [
    null, {}, { ...example, tool: ' ' }, { ...example, tool: 42 }, { ...example, tool: 'x'.repeat(121) },
    { ...example, kind: 'private-example' }, { ...example, summary: ' '.repeat(2) },
    { ...example, summary: '📎'.repeat(201) }, { ...example, summary: 'abc\0' }, { ...example, summary: '\ud800' },
    { ...example, details: 'x'.repeat(4001) }, { ...example, details: null }, { ...example, details: '\n' },
    { ...example, privateExample: 'private-example' },
  ];
  const replies = await exchange(dir, ...[initialize(), initialized, ...bad.map((args, index) => call(index + 2, args))].map(line));
  assert.equal(replies.length, bad.length + 1);
  for (const reply of replies.slice(1)) {
    assert.equal(reply.result.isError, true);
    assert.doesNotMatch(reply.result.content[0].text, /private-example|Synthetic report summary/);
  }
  await assert.rejects(access(join(dir, 'reports.sqlite')), { code: 'ENOENT' });
});

test('MCP persists valid reports and returns only their IDs', async t => {
  const dir = await temporaryDir(t);
  const details = 'First line\nsecond line with emoji 📎';
  const reportFrame = Buffer.from(line(call(2, { ...example, tool: '  Example tool  ', details: ` ${details} ` })));
  const splitAt = reportFrame.indexOf(Buffer.from('📎')) + 2;
  const replies = await exchange(dir, line(initialize()), line(initialized),
    reportFrame.subarray(0, splitAt), reportFrame.subarray(splitAt),
    line(call(3, { tool: 'general', kind: 'other', summary: '📎'.repeat(200) })),
  );
  const ids = replies.slice(1).map(reply => {
    assert.equal(reply.result.isError, false);
    const text = reply.result.content[0].text;
    const match = /^Papercut recorded: (PC-[0-9a-f-]+)$/.exec(text);
    assert.ok(match && isReportId(match[1]), text);
    return match[1];
  });
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  const store = openStore(dir);
  try {
    const [first, second] = ids.map(id => store.get(id));
    assert.ok(first && second);
    assert.equal(first.tool, example.tool);
    assert.equal(first.kind, example.kind);
    assert.equal(first.summary, example.summary);
    assert.equal(first.details, details);
    assert.equal(first.status, 'new');
    assert.equal(second.details, null);
    assert.equal(second.summary, '📎'.repeat(200));
    assert.equal(store.list().length, 2);
  } finally {
    store.close();
  }
});

test('MCP returns a generic error instead of exposing storage paths or input on failure', async t => {
  const dir = await temporaryDir(t);
  const blockedDir = join(dir, 'private-example-path');
  await writeFile(blockedDir, 'this file prevents SQLite from creating the data directory');
  const replies = await exchange(blockedDir, ...[initialize(), initialized, call(2, example), request(3, 'ping')].map(line));
  assert.equal(replies[1].result.isError, true);
  assert.match(replies[1].result.content[0].text, /^Could not save the papercut/);
  assert.doesNotMatch(JSON.stringify(replies), /private-example-path|Synthetic report summary/);
  assert.deepEqual(replies[2].result, {});
});
