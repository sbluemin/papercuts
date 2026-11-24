import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startDashboard } from '../src/dashboard.ts';
import { openStore } from '../src/store.ts';

test('Chromium opens a report from the list and saves its status through the form', { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'papercuts-browser-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let reportId: string;
  const store = openStore(dir);
  try {
    const report = store.create({ tool: 'Browser fixture', kind: 'other', summary: 'Synthetic report for browser CI' });
    reportId = report.id;
    const dashboard = await startDashboard({ store, port: 0, dataLabel: 'synthetic browser test data' });
    try {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ javaScriptEnabled: false });
        page.setDefaultTimeout(5_000);
        const detailUrl = new URL(`/reports/${report.id}`, dashboard.url).href;

        await page.goto(dashboard.url);
        await page.getByRole('link', { name: report.summary, exact: true }).click();
        await page.waitForURL(detailUrl);
        await page.getByRole('heading', { level: 1, name: report.summary, exact: true }).waitFor();

        // Let Chromium submit the HTML form, including its own Origin and Fetch Metadata headers.
        const [response] = await Promise.all([
          page.waitForResponse(res => res.request().method() === 'POST' && res.url() === `${detailUrl}/status`),
          page.getByRole('button', { name: 'Start reviewing', exact: true }).click(),
        ]);
        assert.equal(response.status(), 303, 'the browser form POST should redirect');
        await page.waitForURL(`${detailUrl}?saved=reviewing`);
        assert.equal(await page.getByRole('status').innerText(), 'Status changed to Reviewing.');
      } finally {
        await browser.close();
      }
    } finally {
      await dashboard.close();
    }
  } finally {
    store.close();
  }

  const persisted = openStore(dir);
  try {
    assert.equal(persisted.get(reportId)?.status, 'reviewing');
  } finally {
    persisted.close();
  }
});
