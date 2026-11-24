import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { startDashboard, PAGE_SIZE, type Dashboard } from '../src/dashboard.ts';
import { openStore, type Store } from '../src/store.ts';

// Everything here uses synthetic reports in a throwaway directory. If anything fell back to the
// default store location it would land in this scratch directory, never in ~/.papercuts.
const scratch = mkdtempSync(join(tmpdir(), 'papercuts-dashboard-test-'));
process.env.PAPERCUTS_DATA_DIR = join(scratch, 'env-default');

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const reportHref = (html: string) => /href="(\/reports\/PC-[^"]+)"/.exec(html)?.[1];
const tokenOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? '';

describe('dashboard', () => {
  let dir: string;
  let store: Store;
  let dash: Dashboard;
  let base: string;
  let origin: string;
  const ids: Record<string, string> = {};

  before(async () => {
    dir = join(scratch, 'main');
    store = openStore(dir);
    const clock = mock.timers;
    clock.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
    try {
      ids.xss = store.create({ tool: '<img src=x onerror=alert(1)>', kind: 'failure', summary: '<script>alert("s")</script> & "quoted"', details: '</pre><script>alert(2)</script>‮evil\u0000end\nsecond line' }).id;
      clock.tick(1);
      ids.plain = store.create({ tool: 'Computer controls', kind: 'confusing', summary: 'Click result gave no hint', details: undefined }).id;
    } finally {
      clock.reset();
    }
    dash = await startDashboard({ store, port: 0, dataLabel: 'synthetic test data' });
    base = dash.url.replace(/\/$/, '');
    origin = base;
  });

  after(async () => {
    await dash.close();
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    raw(base + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  const csrf = async () => tokenOf((await raw(`${base}/reports/${ids.plain}`)).body);

  it('binds loopback only and announces a real URL for port 0', () => {
    const address = dash.server.address() as { address: string; port: number };
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    assert.equal(dash.url, `http://127.0.0.1:${address.port}/`);
  });

  it('lists reports newest first with escaped fields and no external assets', async () => {
    const res = await raw(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/html; charset=utf-8/);
    assert.ok(res.body.indexOf('Click result gave no hint') < res.body.indexOf('&lt;script&gt;alert(&quot;s&quot;)'));
    assert.ok(!res.body.includes('<script'));
    assert.ok(!res.body.includes('<img'));
    assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(res.body.includes('synthetic test data'));
    assert.ok(!/(?:src|href|action)="(?:https?:)?\/\//.test(res.body));
    assert.equal(res.body.match(/https?:\/\//g), null);
  });

  it('sends hardening headers and no CORS headers', async () => {
    const res = await raw(`${base}/`, { headers: { origin: 'https://evil.example' } });
    assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.match(res.body, /<meta name="referrer" content="same-origin">/);
    assert.ok(!Object.keys(res.headers).some(h => h.startsWith('access-control-')));
  });

  it('serves the stylesheet and answers HEAD without a body', async () => {
    const css = await raw(`${base}/assets/dashboard.css`);
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /^text\/css/);
    assert.ok(!/@import|url\(\s*['"]?https?:/.test(css.body));
    const head = await raw(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });

  it('shows details escaped, neutralizing control and bidi characters', async () => {
    const list = await raw(`${base}/`);
    const href = list.body.match(/href="(\/reports\/PC-[^"]+)"[^>]*>&lt;script/)?.[1];
    assert.ok(href);
    const res = await raw(base + href);
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes('<script'));
    assert.ok(res.body.includes('&lt;/pre&gt;&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(!/[‪-‮\u0000]/.test(res.body));
    assert.ok(res.body.includes('second line'));
    assert.match(res.body, /data-status="new"/);
  });

  it('explains a report that has no details', async () => {
    const res = await raw(`${base}/reports/${ids.plain}`);
    assert.match(res.body, /No details were included/);
    assert.match(res.body, /Start reviewing/);
    assert.match(res.body, /Mark resolved/);
  });

  it('rejects bad queries and unknown reports with friendly errors', async () => {
    for (const q of ['?status=bogus', '?page=0', '?page=-1', '?page=abc', '?page=99999', '?page=1001']) {
      assert.equal((await raw(`${base}/${q}`)).status, 400, q);
    }
    for (const path of ['/reports/PC-00000000-0000-0000-0000-000000000000', '/reports/not-an-id', '/reports/..%2f..%2fetc', '/reports/', '/nope', '/assets/../src/store.ts']) {
      const res = await raw(base + path);
      assert.equal(res.status, 404, path);
      assert.ok(!/node:|\.ts:\d+/.test(res.body), 'no stack traces');
    }
  });

  it('rejects untrusted Host headers (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${dash.port}`, '127.0.0.1', `127.0.0.1.evil.example:${dash.port}`, `localhost.evil.example:${dash.port}`]) {
      const res = await raw(`${base}/`, { headers: { host } });
      assert.equal(res.status, 403, `host=${host}`);
      assert.ok(!res.body.includes('Click result'));
    }
    assert.equal((await raw(`${base}/`, { headers: { host: `localhost:${dash.port}` } })).status, 200);
  });

  it('rejects a request with no Host header at all', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(dash.port, '127.0.0.1', () => socket.write('GET / HTTP/1.0\r\n\r\n'));
      let out = '';
      socket.on('data', c => { out += c; });
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
  });

  it('only allows the expected methods and offers no CORS preflight', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'POST']) {
      const res = await raw(`${base}/`, { method, headers: { origin } });
      assert.equal(res.status, 405, method);
      assert.ok(!('access-control-allow-origin' in res.headers));
    }
    assert.equal((await raw(`${base}/reports/${ids.plain}/status`)).status, 405);
    assert.equal((await post(`/reports/${ids.plain}`, {})).status, 405);
  });

  it('blocks status changes that lack same-origin proof, and leaves data untouched', async () => {
    const token = await csrf();
    assert.match(token, /^[0-9a-f]{64}$/);
    const path = `/reports/${ids.plain}/status`;
    const attempts: Array<[string, Res]> = [
      ['no token', await post(path, { status: 'resolved' })],
      ['wrong token', await post(path, { status: 'resolved', csrf: 'f'.repeat(64) })],
      ['short token', await post(path, { status: 'resolved', csrf: 'f' })],
      ['cross-origin', await post(path, { status: 'resolved', csrf: token }, { origin: 'https://evil.example' })],
      ['null origin', await post(path, { status: 'resolved', csrf: token }, { origin: 'null' })],
      ['lookalike origin', await post(path, { status: 'resolved', csrf: token }, { origin: `${origin}.evil.example` })],
      ['sec-fetch cross-site', await post(path, { status: 'resolved', csrf: token }, { 'sec-fetch-site': 'cross-site' })],
      ['no origin', await raw(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `status=resolved&csrf=${token}` })],
      ['json body', await post(path, {}, { 'content-type': 'application/json' })],
      ['text/plain body', await raw(base + path, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: `status=resolved&csrf=${token}` })],
      ['bad host', await post(path, { status: 'resolved', csrf: token }, { host: 'evil.example' })],
    ];
    for (const [name, res] of attempts) assert.ok(res.status >= 400 && res.status < 500, `${name} -> ${res.status}`);
    assert.equal(store.get(ids.plain)?.status, 'new');
  });

  it('validates status values, report ids and body size', async () => {
    const token = await csrf();
    assert.equal((await post(`/reports/${ids.plain}/status`, { status: 'deleted', csrf: token })).status, 400);
    assert.equal((await post(`/reports/${ids.plain}/status`, { csrf: token })).status, 400);
    assert.equal((await post('/reports/PC-00000000-0000-0000-0000-000000000000/status', { status: 'resolved', csrf: token })).status, 404);
    assert.equal((await post('/reports/x%27%3B--/status', { status: 'resolved', csrf: token })).status, 404);
    const big = await post(`/reports/${ids.plain}/status`, { status: 'resolved', csrf: token, pad: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
    assert.equal(store.get(ids.plain)?.status, 'new');
  });

  it('changes status through the form, confirms it, and keeps it across a restart', async () => {
    const token = await csrf();
    const res = await post(`/reports/${ids.plain}/status`, { status: 'reviewing', csrf: token });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `/reports/${ids.plain}?saved=reviewing`);
    const after = await raw(base + String(res.headers.location));
    assert.match(after.body, /Status changed to Reviewing\./);
    assert.match(after.body, /data-status="reviewing"/);
    assert.equal(store.get(ids.plain)?.status, 'reviewing');

    // "Restart": a second store + dashboard on the same directory sees the saved state.
    const store2 = openStore(dir);
    const dash2 = await startDashboard({ store: store2, port: 0 });
    try {
      const page = await raw(`${dash2.url}reports/${ids.plain}`);
      assert.match(page.body, /data-status="reviewing"/);
      const list = await raw(`${dash2.url}?status=reviewing`);
      assert.match(list.body, /Click result gave no hint/);
      assert.ok(!list.body.includes('alert(&quot;s&quot;)'));
    } finally {
      await dash2.close();
      store2.close();
    }
    // A page from one run cannot drive another run: tokens are per process.
    const store3 = openStore(dir);
    const dash3 = await startDashboard({ store: store3, port: 0 });
    try {
      const stale = await raw(`${dash3.url}reports/${ids.plain}/status`, { method: 'POST', headers: { origin: dash3.url.slice(0, -1), 'content-type': 'application/x-www-form-urlencoded' }, body: `status=resolved&csrf=${token}` });
      assert.equal(stale.status, 403);
      assert.equal(store.get(ids.plain)?.status, 'reviewing');
    } finally {
      await dash3.close();
      store3.close();
    }
  });

  it('shows friendly empty states for an empty database and an empty filter', async () => {
    const emptyStore = openStore(join(scratch, 'empty'));
    const empty = await startDashboard({ store: emptyStore, port: 0 });
    try {
      const res = await raw(empty.url);
      assert.match(res.body, /No reports yet/);
      assert.match(res.body, /report_papercut/);
      assert.match((await raw(`${empty.url}?status=resolved`)).body, /No resolved reports/);
      assert.match((await raw(`${empty.url}?page=3`)).body, /Nothing on this page/);
    } finally {
      await empty.close();
      emptyStore.close();
    }
  });

  it('pages and filters safely at the page-size limit', async () => {
    const bigStore = openStore(join(scratch, 'paging'));
    const total = PAGE_SIZE * 2 + 5;
    const created = Array.from({ length: total }, (_, i) => bigStore.create({ tool: 't', kind: 'other', summary: `synthetic report ${i}` }));
    for (const r of created.slice(0, 7)) bigStore.setStatus(r.id, 'resolved');
    const paged = await startDashboard({ store: bigStore, port: 0 });
    try {
      const count = (html: string) => html.match(/class="report stitched"/g)?.length ?? 0;
      const p1 = await raw(paged.url);
      const p2 = await raw(`${paged.url}?page=2`);
      const p3 = await raw(`${paged.url}?page=3`);
      assert.equal(count(p1.body), PAGE_SIZE);
      assert.equal(count(p2.body), PAGE_SIZE);
      assert.equal(count(p3.body), 5);
      assert.match(p1.body, /rel="next"/);
      assert.ok(!/rel="next"/.test(p3.body));
      assert.match(p3.body, /rel="prev"/);
      const resolved = await raw(`${paged.url}?status=resolved`);
      assert.equal(count(resolved.body), 7);
      assert.ok(!/rel="next"/.test(resolved.body));
      assert.equal(count((await raw(`${paged.url}?status=new`)).body), PAGE_SIZE);
      assert.match((await raw(`${paged.url}?status=new&page=2`)).body, /synthetic report/);
    } finally {
      await paged.close();
      bigStore.close();
    }
  });

  it('shows a generic error, not internals, when the store fails', async () => {
    const broken = { list() { throw new Error('SECRET /Users/someone/db failure'); }, get() { throw new Error('SECRET'); }, setStatus() { throw new Error('SECRET'); }, create() { throw new Error('SECRET'); }, close() {} } as unknown as Store;
    const d = await startDashboard({ store: broken, port: 0 });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await raw(d.url);
      assert.equal(res.status, 500);
      assert.match(res.body, /Something went wrong/);
      assert.ok(!res.body.includes('SECRET'));
      assert.equal((await raw(`${d.url}reports/PC-00000000-0000-0000-0000-000000000000`)).status, 500);
    } finally {
      console.error = originalError;
      await d.close();
    }
  });

  it('rejects invalid port options', async () => {
    await assert.rejects(startDashboard({ store, port: -1 }), RangeError);
    await assert.rejects(startDashboard({ store, port: 70000 }), RangeError);
  });
});

describe('dashboard command', () => {
  const run = (env: Record<string, string>) => spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'dashboard.ts')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  it('announces the bound URL for PAPERCUTS_PORT=0 and reads only the configured data dir', async () => {
    const dir = join(scratch, 'cli');
    const seeded = openStore(dir);
    const seededId = seeded.create({ tool: 'cli-check', kind: 'missing', summary: 'seeded for the command test' }).id;
    seeded.close();
    const child = run({ PAPERCUTS_PORT: '0', PAPERCUTS_DATA_DIR: dir });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', c => { out += c; const m = /Papercuts dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) resolve(m[1]); });
        child.on('exit', code => reject(new Error(`exited ${code}`)));
        setTimeout(() => reject(new Error('no announcement')), 10_000).unref();
      });
      const res = await raw(line);
      assert.equal(res.status, 200);
      assert.match(res.body, /seeded for the command test/);
      assert.ok(res.body.includes(join(dir, 'reports.sqlite')));
      assert.equal((await raw(`${line}reports/${seededId}`)).status, 200);
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  });

  it('refuses an invalid PAPERCUTS_PORT before touching any data', async () => {
    const dir = join(scratch, 'cli-bad-port');
    const child = run({ PAPERCUTS_PORT: 'abc', PAPERCUTS_DATA_DIR: dir });
    let err = '';
    child.stderr.on('data', c => { err += c; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 2);
    assert.match(err, /PAPERCUTS_PORT/);
    assert.throws(() => rmSync(dir, { recursive: false }), /ENOENT/);
  });
});
