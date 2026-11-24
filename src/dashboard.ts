// Papercuts local dashboard: a loopback-only, script-free web UI over the shared report store.
//
//   GET  /                      list (?status=new|reviewing|resolved, ?page=N)
//   GET  /reports/<id>          detail + manual status change
//   POST /reports/<id>/status   change status (same-origin form, CSRF token required)
//   GET  /assets/dashboard.css  the only asset; nothing is loaded from other origins
//
// Run: `node src/dashboard.ts` (PAPERCUTS_PORT, default 4317, 0 = any free port;
// PAPERCUTS_DATA_DIR selects the report database, default ~/.papercuts).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isReportId, isStatus, openStore, statuses, type Kind, type Report, type Status, type Store } from './store.ts';

export const DEFAULT_PORT = 4317;
export const PAGE_SIZE = 25;
const MAX_PAGE = 1000;
const MAX_BODY = 1024;
const MAX_DETAILS_SHOWN = 20_000;
const HOST = '127.0.0.1';

type Row = Omit<Report, 'details'>;
export type DashboardOptions = {
  store: Store;
  /** TCP port on 127.0.0.1. 0 picks a free port; the real one is on the returned handle. */
  port?: number;
  /** Shown in the page footer so people can see which database they are looking at. */
  dataLabel?: string;
};
export type Dashboard = { url: string; port: number; server: Server; close(): Promise<void> };

const kindLabel: Record<Kind, string> = { failure: 'Failure', inefficiency: 'Inefficiency', confusing: 'Confusing', missing: 'Missing', other: 'Other' };
const statusLabel: Record<Status, string> = { new: 'New', reviewing: 'Reviewing', resolved: 'Resolved' };

// ---------- text safety ----------

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => escapes[c]);
// Control characters and bidi overrides in reports are shown as U+FFFD so they cannot spoof the page.
const clean = (value: unknown) => String(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '�');
const text = (value: unknown) => esc(clean(value));
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? text(iso) : `<time datetime="${esc(d.toISOString())}">${esc(d.toISOString().slice(0, 16).replace('T', ' '))} UTC</time>`;
};
const label = <T extends string>(map: Record<T, string>, key: string): string => (Object.hasOwn(map, key) ? map[key as T] : text(key));

// ---------- views ----------

const listHref = (status: Status | null, page: number) => {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return s ? `/?${s}` : '/';
};

function shell(title: string, body: string, dataLabel: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${text(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
<div class="wrap">
<header class="top">
<a class="mark" href="/">Papercuts</a>
<p class="tag">Friction your tools ran into, saved on this machine.</p>
</header>
<main>
${body}
</main>
<footer class="foot">
<p>Local only. Reading <span class="path">${text(dataLabel)}</span></p>
</footer>
</div>
</body>
</html>`;
}

function notice(title: string, message: string, dataLabel: string, action = '<a class="button" href="/">All reports</a>') {
  return shell(title, `<section class="notice"><h1>${text(title)}</h1><p>${text(message)}</p><p>${action}</p></section>`, dataLabel);
}

function renderList(rows: Row[], status: Status | null, page: number, hasMore: boolean, dataLabel: string): string {
  const tabs = [null, ...statuses].map(s => {
    const current = s === status;
    return `<li><a href="${esc(listHref(s, 1))}"${current ? ' aria-current="page"' : ''}>${s ? statusLabel[s] : 'All'}</a></li>`;
  }).join('');
  let content: string;
  if (rows.length === 0) {
    content = status || page > 1
      ? `<div class="empty"><h2>${status ? `No ${esc(statusLabel[status].toLowerCase())} reports${page > 1 ? ' on this page' : ''}` : 'Nothing on this page'}</h2><p>${status ? 'Reports move here when you change their status.' : 'This page is past the last report.'}</p><p><a class="button" href="/">Show all reports</a></p></div>`
      : `<div class="empty"><h2>No reports yet</h2><p>Reports show up here after a tool call to <code>report_papercut</code>. In Claude Code, ask Claude to report a papercut when a tool gets in your way, then reload this page.</p></div>`;
  } else {
    content = `<ol class="reports">${rows.map(r => {
      const st: Status = isStatus(r.status) ? r.status : 'new';
      const summary = text(r.summary);
      const head = isReportId(r.id) ? `<a href="/reports/${esc(encodeURIComponent(r.id))}">${summary}</a>` : summary;
      return `<li class="report stitched" data-status="${st}"><h2 class="summary">${head}</h2><p class="state badge" data-status="${st}">${esc(statusLabel[st])}</p><p class="meta"><span class="tool">${text(r.tool)}</span><span>${label(kindLabel, r.kind)}</span>${when(r.created_at)}<span class="id">${text(r.id.slice(0, 11))}</span></p></li>`;
    }).join('')}</ol>`;
  }
  const pager = page > 1 || hasMore
    ? `<nav class="pager" aria-label="Pages">${page > 1 ? `<a href="${esc(listHref(status, page - 1))}" rel="prev">Newer</a>` : '<span></span>'}<span>Page ${page}</span>${hasMore ? `<a href="${esc(listHref(status, page + 1))}" rel="next">Older</a>` : '<span></span>'}</nav>`
    : '';
  return shell('Papercuts reports', `<h1 class="page-title">Reports</h1><nav class="filter" aria-label="Filter by status"><ul>${tabs}</ul></nav>${content}${pager}`, dataLabel);
}

function renderDetail(r: Report, csrf: string, saved: Status | null, dataLabel: string): string {
  const st: Status = isStatus(r.status) ? r.status : 'new';
  const shown = r.details === null ? null : clean(r.details);
  const details = shown === null || shown.trim() === ''
    ? '<p class="none">No details were included with this report.</p>'
    : `<pre class="details">${esc(shown.slice(0, MAX_DETAILS_SHOWN))}</pre>${shown.length > MAX_DETAILS_SHOWN ? `<p class="note">Showing the first ${MAX_DETAILS_SHOWN.toLocaleString('en-US')} of ${shown.length.toLocaleString('en-US')} characters.</p>` : ''}`;
  const buttons = statuses.map(s => s === st
    ? `<button type="button" disabled aria-current="true" data-status="${s}">${esc(statusLabel[s])}</button>`
    : `<button type="submit" name="status" value="${s}" data-status="${s}">${s === 'resolved' ? 'Mark resolved' : s === 'reviewing' ? 'Start reviewing' : 'Reopen as new'}</button>`).join('');
  const body = `<p class="back"><a href="/">All reports</a></p>
${saved ? `<p class="banner" role="status">Status changed to ${esc(statusLabel[saved])}.</p>` : ''}
<header class="detail-head stitched" data-status="${st}">
<p class="state badge" data-status="${st}">${esc(statusLabel[st])}</p>
<h1>${text(r.summary)}</h1>
</header>
<div class="cols">
<section class="main" aria-labelledby="details-h"><h2 id="details-h">Details</h2>${details}</section>
<aside class="side">
<section aria-labelledby="status-h"><h2 id="status-h">Status</h2>
<form method="post" action="/reports/${esc(encodeURIComponent(r.id))}/status" class="statuses"><input type="hidden" name="csrf" value="${esc(csrf)}">${buttons}</form></section>
<section aria-labelledby="facts-h"><h2 id="facts-h">About this report</h2>
<dl class="facts"><dt>Tool</dt><dd>${text(r.tool)}</dd><dt>Kind</dt><dd>${label(kindLabel, r.kind)}</dd><dt>Reported</dt><dd>${when(r.created_at)}</dd><dt>Updated</dt><dd>${when(r.updated_at)}</dd><dt>Report ID</dt><dd class="id">${text(r.id)}</dd></dl></section>
</aside>
</div>`;
  return shell(`${clean(r.summary).slice(0, 80)} (Papercuts)`, body, dataLabel);
}

const css = `:root{color-scheme:light dark;--paper:#f1f4f1;--sheet:#fbfcfb;--ink:#1a2326;--muted:#56646a;--rule:#cdd6d2;--cut:#b3261e;--amber:#8a5a00;--healed:#1b6b58;--focus:#1d5fd1;
--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#111719;--sheet:#182022;--ink:#e6ecea;--muted:#9bacb0;--rule:#2d3a3d;--cut:#ff7a6e;--amber:#e8aa40;--healed:#52c8aa;--focus:#8bb2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.55 var(--sans);-webkit-text-size-adjust:100%}
a{color:inherit;text-underline-offset:.2em}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:2px}
.wrap{max-width:58rem;margin:0 auto;padding:0 1rem}
.top{padding:1.75rem 0 1rem;display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1.25rem;border-bottom:2px solid var(--ink)}
.mark{font:italic 700 1.75rem/1 var(--serif);text-decoration:none;letter-spacing:-.01em}
.tag{margin:0;color:var(--muted);font-size:.9rem}
main{padding:1.5rem 0 2rem;min-height:60vh}
h1,h2{font-weight:600;line-height:1.25;margin:0}
.page-title{font:600 1.5rem/1.2 var(--serif);margin-bottom:1rem}
.filter ul{list-style:none;margin:0 0 .5rem;padding:0;display:flex;flex-wrap:wrap;gap:.25rem}
.filter a{display:inline-block;padding:.5rem .9rem;min-height:2.75rem;line-height:1.75rem;text-decoration:none;border:1px solid var(--rule);border-radius:999px;background:var(--sheet)}
.filter a:hover{border-color:var(--ink)}
.filter a[aria-current]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
[data-status=new]{--stitch:var(--cut)}
[data-status=reviewing]{--stitch:var(--amber)}
[data-status=resolved]{--stitch:var(--healed)}
[data-status=new].stitched::before,[data-status=new].badge::before{background:var(--cut)}
[data-status=reviewing].stitched::before,[data-status=reviewing].badge::before{background:repeating-linear-gradient(to bottom,var(--amber) 0 7px,transparent 7px 11px)}
[data-status=resolved].stitched::before,[data-status=resolved].badge::before{background:repeating-linear-gradient(to bottom,var(--healed) 0 2px,transparent 2px 5px)}
.stitched{position:relative;padding-left:1.35rem}
.stitched::before{content:"";position:absolute;left:0;top:.9rem;bottom:.9rem;width:4px;border-radius:2px}
.reports{list-style:none;margin:0;padding:0}
.report{display:grid;grid-template-columns:1fr auto;gap:.2rem 1rem;padding:1rem 0 1rem 1.35rem;border-bottom:1px solid var(--rule)}
.report:hover{background:var(--sheet)}
.summary{font:500 1.2rem/1.35 var(--serif);overflow-wrap:anywhere}
.summary a{text-decoration:none}
.summary a:hover{text-decoration:underline}
.state{margin:0;font-size:.85rem;font-weight:600;color:var(--stitch);white-space:nowrap;align-self:start}
.badge{display:inline-flex;align-items:center;gap:.5rem}
.badge::before{content:"";display:inline-block;width:4px;height:1em;border-radius:2px}
.meta{grid-column:1/-1;margin:0;display:flex;flex-wrap:wrap;gap:.1rem 1.1rem;color:var(--muted);font-size:.85rem}
.tool{color:var(--ink);font-weight:600;overflow-wrap:anywhere}
.id,.path,code{font-family:var(--mono);font-size:.85em}
.pager{display:flex;justify-content:space-between;align-items:center;margin-top:1.25rem;color:var(--muted)}
.pager a{padding:.5rem .9rem;border:1px solid var(--rule);border-radius:999px;background:var(--sheet);text-decoration:none;color:var(--ink)}
.empty,.notice{max-width:36rem;padding:2rem 0}
.empty h2,.notice h1{font:600 1.4rem/1.3 var(--serif);margin-bottom:.5rem}
.empty p,.notice p{margin:.5rem 0}
.button,button{font:inherit;display:inline-block;min-height:2.75rem;padding:.55rem 1rem;border:1px solid var(--ink);border-radius:6px;background:var(--sheet);color:var(--ink);text-decoration:none;cursor:pointer}
.button:hover,button:hover:not(:disabled){background:var(--ink);color:var(--paper)}
.note,.none{color:var(--muted);font-size:.9rem}
.back{margin:0 0 1rem;font-size:.9rem}
.back a::before{content:"\\2039\\00a0"}
.banner{margin:0 0 1rem;padding:.6rem .9rem;border:1px solid var(--healed);border-left-width:4px;background:var(--sheet)}
.detail-head{padding-bottom:1rem;margin-bottom:1.25rem;border-bottom:1px solid var(--rule)}
.detail-head h1{font:600 clamp(1.5rem,4vw,2.1rem)/1.25 var(--serif);overflow-wrap:anywhere;margin-top:.25rem}
.cols{display:grid;gap:1.75rem;grid-template-columns:minmax(0,1fr)}
@media (min-width:52rem){.cols{grid-template-columns:minmax(0,1fr) 17rem}}
.cols h2{font-size:.95rem;margin-bottom:.6rem;color:var(--muted)}
.details{margin:0;padding:1rem;background:var(--sheet);border:1px solid var(--rule);border-radius:6px;font:.92rem/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-width:72ch}
.side section+section{margin-top:1.5rem}
.statuses{display:flex;flex-direction:column;gap:.5rem}
.statuses button{text-align:left}
.statuses button:disabled{cursor:default;border-style:dashed;border-color:var(--stitch);color:var(--stitch);font-weight:600;background:transparent}
.facts{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;font-size:.9rem}
.facts dt{color:var(--muted)}
.facts dd{margin:0;overflow-wrap:anywhere}
.foot{border-top:1px solid var(--rule);padding:1rem 0 2rem;color:var(--muted);font-size:.8rem}
.foot p{margin:0;overflow-wrap:anywhere}
@media (max-width:30rem){.report{grid-template-columns:1fr}.state{order:-1}}
`;

// ---------- HTTP plumbing ----------

const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // same-origin (not no-referrer): browsers send `Origin: null` on form POSTs under no-referrer, which the strict Origin check must refuse.
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function send(req: IncomingMessage, res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) { settled = true; req.pause(); resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', error => { if (!settled) { settled = true; reject(error); } });
  });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** One list page, newest first; the store filters by status in SQL. */
function pageOf(store: Store, status: Status | null, page: number): { rows: Row[]; hasMore: boolean } {
  const rows = store.list(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE, status ?? undefined);
  return { rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const { store } = options;
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid dashboard port');
  const dataLabel = options.dataLabel ?? 'the local Papercuts database';
  const csrf = randomBytes(32).toString('hex'); // per process; only ever embedded in pages served to an allowed Host
  let boundPort = 0;

  const fail = (req: IncomingMessage, res: ServerResponse, status: number, title: string, message: string, extra: Record<string, string> = {}) =>
    send(req, res, status, notice(title, message, dataLabel), undefined, extra);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding guard: only our own loopback names on our own port.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
      return fail(req, res, 403, 'Wrong address', `Open the dashboard at http://127.0.0.1:${boundPort}/ to use it.`);
    }
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;
    const reportMatch = /^\/reports\/([^/]+)(\/status)?$/.exec(path);

    if (path === '/assets/dashboard.css') {
      if (method !== 'GET' && method !== 'HEAD') return fail(req, res, 405, 'Method not allowed', 'This address only supports reading.', { Allow: 'GET, HEAD' });
      return send(req, res, 200, css, 'text/css; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }

    if (path === '/') {
      if (method !== 'GET' && method !== 'HEAD') return fail(req, res, 405, 'Method not allowed', 'This address only supports reading.', { Allow: 'GET, HEAD' });
      const statusParam = url.searchParams.get('status');
      const pageParam = url.searchParams.get('page');
      if (statusParam !== null && statusParam !== '' && !isStatus(statusParam)) return fail(req, res, 400, 'Unknown status', 'Filter by new, reviewing or resolved.');
      if (pageParam !== null && !/^[1-9][0-9]{0,3}$/.test(pageParam)) return fail(req, res, 400, 'Unknown page', 'Page numbers start at 1.');
      const status = statusParam && isStatus(statusParam) ? statusParam : null;
      const page = pageParam ? Number(pageParam) : 1;
      if (page > MAX_PAGE) return fail(req, res, 400, 'Unknown page', 'That page is out of range.');
      const { rows, hasMore } = pageOf(store, status, page);
      return send(req, res, 200, renderList(rows, status, page, hasMore, dataLabel));
    }

    if (reportMatch) {
      const [, id, action] = reportMatch;
      if (!isReportId(id)) return fail(req, res, 404, 'Report not found', 'No report has that ID.');
      if (!action) {
        if (method !== 'GET' && method !== 'HEAD') return fail(req, res, 405, 'Method not allowed', 'This address only supports reading.', { Allow: 'GET, HEAD' });
        const report = store.get(id);
        if (!report) return fail(req, res, 404, 'Report not found', 'No report has that ID. It may belong to a different database.');
        const savedParam = url.searchParams.get('saved');
        return send(req, res, 200, renderDetail(report, csrf, savedParam && isStatus(savedParam) ? savedParam : null, dataLabel));
      }
      if (method !== 'POST') return fail(req, res, 405, 'Method not allowed', 'Change a status from the report page.', { Allow: 'POST' });
      // Cross-site state change protection: same-origin Origin, Fetch Metadata, form content type, token.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      const refuse = (why: string) => fail(req, res, 403, 'Request refused', `${why} Reload the report from the dashboard and try again.`);
      if (origin !== `http://${host}`) return refuse('The request did not come from this dashboard.');
      if (site !== undefined && site !== 'same-origin') return refuse('The request came from another site.');
      if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return fail(req, res, 415, 'Unsupported request', 'Use the status buttons on the report page.');
      const declared = Number(req.headers['content-length'] ?? 0);
      const raw = Number.isFinite(declared) && declared <= MAX_BODY ? await readBody(req, MAX_BODY) : null;
      if (raw === null) return fail(req, res, 413, 'Request too large', 'The status form is small. Use the buttons on the report page.', { Connection: 'close' });
      const form = new URLSearchParams(raw);
      const token = form.get('csrf');
      if (token === null || !sameToken(token, csrf)) return refuse('The page was out of date.');
      const next = form.get('status');
      if (next === null || !isStatus(next)) return fail(req, res, 400, 'Unknown status', 'Choose new, reviewing or resolved.');
      if (!store.setStatus(id, next)) return fail(req, res, 404, 'Report not found', 'No report has that ID, so nothing was changed.');
      res.writeHead(303, { ...securityHeaders, Location: `/reports/${encodeURIComponent(id)}?saved=${next}`, 'Content-Length': 0 });
      return void res.end();
    }

    return fail(req, res, 404, 'Page not found', 'There is nothing at this address.');
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(error => {
      console.error('dashboard: request failed while reading or updating the report database');
      if (res.headersSent) return void res.destroy();
      fail(req, res, 500, 'Something went wrong', 'The dashboard could not read the report database. Make sure nothing else has it locked, then reload.');
    });
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: HOST }, () => { server.off('error', reject); resolve(); });
  });
  boundPort = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST}:${boundPort}/`,
    port: boundPort,
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

// ---------- CLI ----------

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) > 65535) throw new Error(`PAPERCUTS_PORT must be a port number from 0 to 65535, got "${value}"`);
  return Number(value);
}

async function main(): Promise<void> {
  let port: number;
  try { port = parsePort(process.env.PAPERCUTS_PORT); } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const dir = process.env.PAPERCUTS_DATA_DIR ?? join(homedir(), '.papercuts');
  const store = openStore(process.env.PAPERCUTS_DATA_DIR);
  let dashboard: Dashboard;
  try {
    dashboard = await startDashboard({ store, port, dataLabel: join(dir, 'reports.sqlite') });
  } catch (error) {
    store.close();
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PAPERCUTS_PORT to another port, or 0 for any free one.` : 'Could not start the dashboard. Check PAPERCUTS_PORT and PAPERCUTS_DATA_DIR.');
    process.exit(1);
  }
  console.log(`Papercuts dashboard: ${dashboard.url}`);
  const stop = () => { dashboard.close().finally(() => { store.close(); process.exit(0); }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.main) await main();
