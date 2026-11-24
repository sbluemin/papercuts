import pkg from '../package.json' with { type: 'json' };
import { kinds, openStore, type Kind, type Store } from './store.ts';

const protocolVersions = ['2025-11-25', '2025-06-18'];
const fields = { tool: 120, summary: 200, details: 4000 } as const;
const tool = {
  name: 'report_papercut',
  description: 'Record tool friction locally and receive a report ID. Use only when the user explicitly asks to record a report. Include only facts needed to describe the issue. Omit credentials, personal information, and raw inputs, outputs, or logs.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', minLength: 1, maxLength: fields.tool, description: 'Name of the affected tool, or general if none applies.' },
      kind: { type: 'string', enum: kinds, description: 'Category of the issue.' },
      summary: { type: 'string', minLength: 1, maxLength: fields.summary, description: 'Short summary of the issue.' },
      details: { type: 'string', minLength: 1, maxLength: fields.details, description: 'Optional additional context, with sensitive information omitted.' },
    },
    required: ['tool', 'kind', 'summary'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || [...value].length > max || !value.isWellFormed() || value.includes('\0')) return;
  return value.trim() || undefined;
}

function isKind(value: unknown): value is Kind {
  return kinds.some(kind => kind === value);
}

const toolResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });

type Id = string | number;
const rpcError = (id: Id | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const isId = (value: unknown): value is Id => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

let state: 'new' | 'initializing' | 'ready' = 'new';
let store: Store | undefined;

function dispatch(message: unknown) {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(null, -32600, 'Invalid request.');
  }
  const { method, params, id } = message;
  if (!Object.hasOwn(message, 'id')) {
    // Clients send notifications without an ID; never respond to them.
    if (method === 'notifications/initialized' && state === 'initializing' && (params === undefined || isObject(params))) state = 'ready';
    return;
  }
  if (!isId(id)) return rpcError(null, -32600, 'Invalid request ID.');
  if (params !== undefined && !isObject(params)) return rpcError(id, -32602, 'Invalid parameters.');

  if (method === 'ping') return rpcResult(id, {});
  if (method === 'initialize') {
    if (state !== 'new') return rpcError(id, -32600, 'Server is already initializing or initialized.');
    if (!isObject(params) || typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) ||
        !isObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
      return rpcError(id, -32602, 'Invalid initialize parameters.');
    }
    const protocolVersion = protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0];
    state = 'initializing';
    return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: pkg.name, version: pkg.version } });
  }
  if (state !== 'ready') return rpcError(id, -32000, 'Server is not initialized.');
  if (method === 'tools/list') return rpcResult(id, { tools: [tool] });
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found.');
  if (params?.name !== tool.name) return rpcError(id, -32602, 'Unknown or missing tool name.');

  const args = params.arguments;
  if (!isObject(args) || Object.keys(args).some(key => !['tool', 'kind', 'summary', 'details'].includes(key))) {
    return rpcResult(id, toolResult('Provide only tool, kind, summary, and optional details.', true));
  }
  const name = cleanText(args.tool, fields.tool);
  const summary = cleanText(args.summary, fields.summary);
  const details = cleanText(args.details, fields.details);
  if (name === undefined) return rpcResult(id, toolResult(`Tool must be nonblank text of at most ${fields.tool} characters.`, true));
  if (!isKind(args.kind)) return rpcResult(id, toolResult(`Kind must be one of: ${kinds.join(', ')}.`, true));
  if (summary === undefined) return rpcResult(id, toolResult(`Summary must be nonblank text of at most ${fields.summary} characters.`, true));
  if (Object.hasOwn(args, 'details') && details === undefined) {
    return rpcResult(id, toolResult(`Details must be nonblank text of at most ${fields.details} characters when supplied.`, true));
  }
  try {
    store ??= openStore();
    const report = store.create({ tool: name, kind: args.kind, summary, details });
    return rpcResult(id, toolResult(`Papercut recorded: ${report.id}`));
  } catch {
    // Neither SQLite errors nor report content are passed to the client or logs.
    return rpcResult(id, toolResult('Could not save the papercut to the local database. Check the data directory and try again.', true));
  }
}

const maxFrameBytes = 64 * 1024;

// MCP stdio uses LF-delimited UTF-8 JSON. Bound buffered input and discard an
// oversized frame up to its delimiter so later requests can still be handled.
async function* frames(): AsyncGenerator<Buffer | null> {
  let parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    for (let start = 0; start < chunk.length;) {
      const lf = chunk.indexOf(10, start);
      const end = lf < 0 ? chunk.length : lf;
      size += end - start;
      if (size > maxFrameBytes) parts = [];
      else if (end > start) parts.push(chunk.subarray(start, end));
      if (lf >= 0) {
        yield size > maxFrameBytes ? null : Buffer.concat(parts, size);
        parts = [];
        size = 0;
      }
      start = end + 1;
    }
  }
  if (size > 0) yield size > maxFrameBytes ? null : Buffer.concat(parts, size);
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function handleFrame(frame: Buffer | null) {
  if (frame === null) return rpcError(null, -32700, 'Message exceeds the stdio size limit.');
  if (frame.length === 0 || (frame.length === 1 && frame[0] === 13)) return; // Ignore empty lines.
  let message: unknown;
  try {
    message = JSON.parse(decoder.decode(frame));
  } catch {
    return rpcError(null, -32700, 'Parse error.');
  }
  return dispatch(message);
}

// A piped client may disappear mid-write. Handle the stream event as well as
// the write callback below so Node does not emit an uncaught error stack.
process.stdout.on('error', () => {});
try {
  for await (const frame of frames()) {
    const response = handleFrame(frame);
    if (response !== undefined) {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(response)}\n`, error => error ? reject(error) : resolve());
      });
    }
  }
} catch {
  process.stderr.write('Papercuts MCP stdio failed.\n');
  process.exitCode = 1;
} finally {
  store?.close();
}
