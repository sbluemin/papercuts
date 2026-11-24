import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const kinds = ['failure', 'inefficiency', 'confusing', 'missing', 'other'] as const;
export const statuses = ['new', 'reviewing', 'resolved'] as const;
export type Kind = typeof kinds[number];
export type Status = typeof statuses[number];
export type ReportInput = { tool: string; kind: Kind; summary: string; details?: string };
export type Report = { id: string; tool: string; kind: Kind; summary: string; details: string | null; status: Status; created_at: string; updated_at: string };

type ReportSummary = Omit<Report, 'details'>;
const uuidPattern = /^PC-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const isReportId = (value: string) => uuidPattern.test(value);
export const isStatus = (value: unknown): value is Status => statuses.some(s => s === value);

export function openStore(dir = process.env.PAPERCUTS_DATA_DIR ?? join(homedir(), '.papercuts')) {
  if (!isAbsolute(dir)) throw new Error('PAPERCUTS_DATA_DIR must be an absolute path');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'reports.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0) {
      db.exec(`CREATE TABLE reports (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('failure','inefficiency','confusing','missing','other')),
        summary TEXT NOT NULL, details TEXT, status TEXT NOT NULL CHECK (status IN ('new','reviewing','resolved')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT; CREATE INDEX reports_recent ON reports(created_at DESC, id DESC);`);
    } else if (version !== 1 && version !== 2) {
      throw new Error('Unsupported Papercuts database version');
    }
    if (version !== 2) db.exec('CREATE INDEX reports_by_status ON reports(status, created_at DESC, id DESC); PRAGMA user_version = 2;');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    throw error;
  }
  const insert = db.prepare('INSERT INTO reports (id, tool, kind, summary, details, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const get = db.prepare('SELECT * FROM reports WHERE id = ?');
  const columns = 'id, tool, kind, summary, status, created_at, updated_at';
  const order = 'ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  const list = db.prepare(`SELECT ${columns} FROM reports ${order}`);
  const listByStatus = db.prepare(`SELECT ${columns} FROM reports WHERE status = ? ${order}`);
  const update = db.prepare('UPDATE reports SET status = ?, updated_at = ? WHERE id = ?');
  return {
    create(input: ReportInput): Report {
      const timestamp = new Date().toISOString();
      const report: Report = { ...input, details: input.details ?? null, id: `PC-${randomUUID()}`, status: 'new', created_at: timestamp, updated_at: timestamp };
      insert.run(report.id, report.tool, report.kind, report.summary, report.details, report.status, timestamp, timestamp);
      return report;
    },
    list(limit = 50, offset = 0, status?: Status): ReportSummary[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid report page');
      if (status !== undefined && !isStatus(status)) throw new TypeError('Invalid report status');
      return (status === undefined ? list.all(limit, offset) : listByStatus.all(status, limit, offset)) as unknown as ReportSummary[];
    },
    get(id: string): Report | undefined { return get.get(id) as Report | undefined; },
    setStatus(id: string, status: Status): boolean {
      if (!isStatus(status)) throw new TypeError('Invalid report status');
      return update.run(status, new Date().toISOString(), id).changes === 1;
    },
    close(): void { db.close(); },
  };
}

export type Store = ReturnType<typeof openStore>;
