import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SIMULATION_DISCLAIMER } from './protocol.js';
import type { IntentDetail, IntentList, SimulationEvent, SimulationIntent, SimulationIntentRequest, SimulationStatus } from './protocol.js';

interface IntentRow {
  id: string; idempotency_key: string; request_hash: string; request_json: string;
  status: SimulationStatus; created_at: string; updated_at: string;
}
interface EventRow { sequence: number; intent_id: string; kind: SimulationEvent['kind']; created_at: string; detail: string; }

export class IntentConflict extends Error {}
export class IntentNotFound extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Unsupported simulation request value.');
  return serialized;
}

function fromRow(row: IntentRow): SimulationIntent {
  return {
    id: row.id, status: row.status, request: JSON.parse(row.request_json) as SimulationIntentRequest,
    createdAt: row.created_at, updatedAt: row.updated_at, disclaimer: SIMULATION_DISCLAIMER,
  };
}

export class IntentStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== 1) throw new Error('Unsupported host database version.');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS intents (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          request_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('RECORDED', 'SIMULATED', 'SIMULATION_CANCELLED')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intent_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          intent_id TEXT NOT NULL REFERENCES intents(id),
          kind TEXT NOT NULL,
          created_at TEXT NOT NULL,
          detail TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_by_intent ON intent_events(intent_id, sequence);
        PRAGMA user_version = 1;
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private transaction<T>(run: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** This durable commit precedes even the local simulation completion. */
  record(request: SimulationIntentRequest): { intent: SimulationIntent; reused: boolean } {
    if (request.mode !== 'simulation') throw new Error('Only simulation is supported.');
    const requestHash = createHash('sha256').update(canonical(request)).digest('hex');
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM intents WHERE idempotency_key = ?').get(request.idempotencyKey) as IntentRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new IntentConflict('Idempotency key was already used for a different request.');
        return { intent: fromRow(existing), reused: true };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database.prepare('INSERT INTO intents VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, request.idempotencyKey, requestHash, JSON.stringify(request), 'RECORDED', now, now,
      );
      this.event(id, 'INTENT_RECORDED', now, '已可靠保存仅模拟意图；尚无任何平台动作。');
      return { intent: this.detail(id).intent, reused: false };
    });
  }

  complete(id: string, recovered = false): SimulationIntent {
    return this.transaction(() => {
      const intent = this.detail(id).intent;
      if (intent.status !== 'RECORDED') return intent;
      const now = new Date().toISOString();
      this.database.prepare("UPDATE intents SET status = 'SIMULATED', updated_at = ? WHERE id = ? AND status = 'RECORDED'").run(now, id);
      this.event(id, recovered ? 'SIMULATION_RECOVERED' : 'SIMULATION_RECORDED', now, SIMULATION_DISCLAIMER);
      return this.detail(id).intent;
    });
  }

  recover(): number {
    const rows = this.database.prepare("SELECT id FROM intents WHERE status = 'RECORDED'").all() as Array<{ id: string }>;
    for (const row of rows) this.complete(row.id, true);
    return rows.length;
  }

  cancel(id: string): IntentDetail {
    return this.transaction(() => {
      const intent = this.detail(id).intent;
      if (intent.status === 'SIMULATION_CANCELLED') return this.detail(id);
      const now = new Date().toISOString();
      this.database.prepare("UPDATE intents SET status = 'SIMULATION_CANCELLED', updated_at = ? WHERE id = ?").run(now, id);
      this.event(id, 'SIMULATION_CANCELLED', now, '仅将本地模拟记录标记取消；不存在平台订单或真实撤单。');
      return this.detail(id);
    });
  }

  detail(id: string): IntentDetail {
    const row = this.database.prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
    if (!row) throw new IntentNotFound('Simulation intent not found.');
    const rows = this.database.prepare('SELECT * FROM intent_events WHERE intent_id = ? ORDER BY sequence').all(id) as unknown as EventRow[];
    return {
      intent: fromRow(row),
      events: rows.map(event => ({ sequence: Number(event.sequence), intentId: event.intent_id, kind: event.kind, createdAt: event.created_at, detail: event.detail })),
    };
  }

  list(limit = 50, offset = 0): IntentList {
    const rows = this.database.prepare('SELECT * FROM intents ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as IntentRow[];
    const total = this.database.prepare('SELECT COUNT(*) AS count FROM intents').get() as { count: number };
    return { mode: 'simulation', items: rows.map(fromRow), total: Number(total.count), limit, offset };
  }

  private event(id: string, kind: SimulationEvent['kind'], now: string, detail: string): void {
    this.database.prepare('INSERT INTO intent_events (intent_id, kind, created_at, detail) VALUES (?, ?, ?, ?)').run(id, kind, now, detail);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
