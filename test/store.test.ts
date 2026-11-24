import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isReportId, openStore } from '../src/store.ts';

void test('separate connections share reports and persisted review status', t => {
  const dir = mkdtempSync(join(tmpdir(), 'papercuts-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writer = openStore(dir);
  try {
    const reader = openStore(dir);
    try {
      const report = writer.create({ tool: 'synthetic tool', kind: 'missing', summary: 'Synthetic input', details: 'Synthetic detail' });
      ok(isReportId(report.id));
      equal(report.status, 'new');
      equal(reader.list()[0].id, report.id);
      equal(Object.hasOwn(reader.list()[0], 'details'), false);
      equal(reader.get(report.id)?.details, 'Synthetic detail');
      equal(reader.setStatus(report.id, 'resolved'), true);
      equal(writer.get(report.id)?.status, 'resolved');
      deepEqual(reader.list(1, 0, 'new'), []);
      equal(reader.list(1, 0, 'resolved')[0].id, report.id);
      deepEqual(reader.list(1, 1), []);
      throws(() => reader.list(101), RangeError);
    } finally {
      reader.close();
    }
  } finally {
    writer.close();
  }
  const reopened = openStore(dir);
  try { equal(reopened.list()[0].status, 'resolved'); } finally { reopened.close(); }
});

void test('version 1 databases migrate without losing reports', t => {
  const dir = mkdtempSync(join(tmpdir(), 'papercuts-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  const { id } = store.create({ tool: 'fixture', kind: 'other', summary: 'Migration fixture' });
  store.close();
  const db = new DatabaseSync(join(dir, 'reports.sqlite'));
  db.exec('DROP INDEX reports_by_status; PRAGMA user_version = 1');
  db.close();
  const reopened = openStore(dir);
  try { equal(reopened.list(1, 0, 'new')[0].id, id); } finally { reopened.close(); }
});

void test('relative data directories are rejected', () => {
  throws(() => openStore('relative'), /absolute path/);
});
