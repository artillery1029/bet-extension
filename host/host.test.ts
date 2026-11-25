import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEV_ORIGINS, loadHostConfig } from './config.js';
import type { HostConfig } from './config.js';
import type { SimulationIntentRequest } from './protocol.js';
import { buildHost } from './server.js';
import { IntentStore } from './store.js';

const folders: string[] = [];
const apps: ReturnType<typeof buildHost>[] = [];
function configuration(): HostConfig {
  const directory = mkdtempSync(join(tmpdir(), 'xhh-host-test-'));
  folders.push(directory);
  return { bind: '127.0.0.1', port: 7073, databasePath: join(directory, 'intents.sqlite'),
    sessionToken: randomBytes(32).toString('base64url'), allowedOrigins: new Set(DEV_ORIGINS) };
}
function host(config = configuration()) { const app = buildHost(config); apps.push(app); return { app, config }; }
function headers(config: HostConfig) { return { host: '127.0.0.1:7073', origin: DEV_ORIGINS[0], authorization: `Bearer ${config.sessionToken}` }; }
function request(): SimulationIntentRequest {
  return { mode: 'simulation', idempotencyKey: 'simulation-test-key-0001', scanId: 'scan:test', eventGroupId: 'event:test', eventLabel: '本地测试',
    sourceObservedAt: '2026-11-25T19:00:00.000Z', targetReturn: '100', estimatedCost: '102', estimatedMinReturn: '100',
    positions: [{ legId: 'leg:1', venue: 'sx', marketId: 'market:test', label: '演示选择', levelIndex: 0, price: '0.5', quantity: '100', stake: '50', fee: '0' }] };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of folders.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}xhh-host-test-`)) throw new Error('Unsafe test cleanup target.');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('simulation-only local host', () => {
  it('requires a paired token, an exact trusted origin, and a loopback Host header on reads and writes', async () => {
    const { app, config } = host();
    expect((await app.inject({ url: '/api/health', headers: headers(config) })).json()).toEqual({
      service: 'xhh-bet-host', status: 'ok', mode: 'simulation', liveTradingEnabled: false, persistence: 'sqlite-wal',
    });
    for (const change of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { host: 'evil.example:7073' }, { authorization: 'Bearer wrong' }]) {
      const result = await app.inject({ url: '/api/health', headers: { ...headers(config), ...change } });
      expect([401, 403]).toContain(result.statusCode);
      expect(result.body).not.toContain(config.sessionToken);
    }
    const missing = { ...headers(config) }; delete (missing as { origin?: string }).origin;
    expect((await app.inject({ url: '/api/intents', headers: missing })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', remoteAddress: '192.0.2.4', headers: headers(config) })).statusCode).toBe(403);
  });

  it('only accepts preflights from approved origins and permits an explicitly configured extension ID', async () => {
    const config = configuration();
    config.allowedOrigins = new Set([...DEV_ORIGINS, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    const { app } = host(config);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/intents', headers: {
      host: '127.0.0.1:7073', origin: DEV_ORIGINS[0], 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type',
    } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(DEV_ORIGINS[0]);
    expect((await app.inject({ url: '/api/health', headers: { ...headers(config), origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'OPTIONS', url: '/api/intents', headers: { host: '127.0.0.1:7073', origin: 'https://evil.example', 'access-control-request-method': 'POST' } })).statusCode).toBe(403);
    const extensionHeaders = { host: '127.0.0.1:7073', 'x-xhh-extension-id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', authorization: `Bearer ${config.sessionToken}` };
    expect((await app.inject({ url: '/api/health', headers: extensionHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/health', headers: { ...extensionHeaders, authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/health', headers: { ...extensionHeaders, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/health', headers: { ...extensionHeaders, 'x-xhh-extension-id': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } })).statusCode).toBe(403);
  });

  it('saves one intent and two truthful events for concurrent identical retries, rejects conflicting reuse', async () => {
    const { app, config } = host(); const payload = request();
    const results = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload })));
    expect(results.filter(result => result.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map(result => result.json().intent.id)).size).toBe(1);
    const detail = results[0]!.json();
    expect(detail.intent.status).toBe('SIMULATED');
    expect(detail.events.map((event: { kind: string }) => event.kind)).toEqual(['INTENT_RECORDED', 'SIMULATION_RECORDED']);
    expect(detail.intent.disclaimer).toContain('未产生真实成交');
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect((await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload: reordered })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload: { ...payload, estimatedCost: '99' } })).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/intents', headers: headers(config) })).json().total).toBe(1);
  });

  it('recovers a durable RECORDED intent across a database restart without duplicating it', async () => {
    const config = configuration();
    const first = new IntentStore(config.databasePath);
    const prepared = first.record(request());
    expect(prepared.intent.status).toBe('RECORDED');
    first.close();
    const check = new DatabaseSync(config.databasePath);
    expect((check.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    check.close();
    const restarted = host(config);
    const detail = (await restarted.app.inject({ url: `/api/intents/${prepared.intent.id}`, headers: headers(config) })).json();
    expect(detail.intent.status).toBe('SIMULATED');
    expect(detail.events.map((event: { kind: string }) => event.kind)).toEqual(['INTENT_RECORDED', 'SIMULATION_RECOVERED']);
    await restarted.app.close();
    const again = host(config);
    const retry = await again.app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload: request() });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().intent.id).toBe(prepared.intent.id);
    expect(retry.json().events).toHaveLength(2);
  });

  it('preserves research quantities without truncating their decimal precision', async () => {
    const { app, config } = host();
    const payload = request(); payload.positions[0]!.quantity = '100.123456789123';
    payload.positions[0]!.price = '0.99999999999999999999';
    const response = await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload });
    expect(response.statusCode).toBe(201);
    expect(response.json().intent.request.positions[0].quantity).toBe('100.123456789123');
    expect(response.json().intent.request.positions[0].price).toBe('0.99999999999999999999');
  });

  it('persists replay identity and the original quote timestamp without re-dating it', async () => {
    const { app, config } = host();
    const payload = { ...request(), sourceMode: 'replay' as const, sourceObservedAt: '2026-11-25T18:41:45.656Z' };
    const created = await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload });
    expect(created.statusCode).toBe(201);
    const id = created.json().intent.id;
    await app.close();
    const restarted = host(config);
    const stored = (await restarted.app.inject({ url: `/api/intents/${id}`, headers: headers(config) })).json().intent;
    expect(stored.request.sourceMode).toBe('replay');
    expect(stored.request.sourceObservedAt).toBe('2026-11-25T18:41:45.656Z');
    expect(stored.status).toBe('SIMULATED');
  });

  it('rejects live mode, unknown fields, unsafe decimal data, invalid limits and oversized bodies without saving', async () => {
    const { app, config } = host(); const base = request();
    for (const payload of [{ ...base, mode: 'live' }, { ...base, privateKey: 'never-log-this' }, { ...base, targetReturn: '-1' },
      { ...base, sourceObservedAt: '2026-02-30T19:00:00.000Z' },
      { ...base, sourceMode: 'live_trading' },
      { ...base, positions: [{ ...base.positions[0], quantity: '0' }] }, { ...base, positions: [{ ...base.positions[0], price: '1' }] },
      { ...base, positions: [{ ...base.positions[0], native: { privateKey: 'never-log-this' } }] }]) {
      const result = await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload });
      expect(result.statusCode).toBe(400); expect(result.body).not.toContain('never-log-this');
    }
    expect((await app.inject({ url: '/api/intents?limit=10000', headers: headers(config) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload: { ...base, eventLabel: 'a'.repeat(70_000) } })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/api/orders/live', headers: headers(config), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/intents', headers: headers(config) })).json().total).toBe(0);
  });

  it('a local cancellation remains cancelled when the original idempotency key is replayed', async () => {
    const { app, config } = host();
    const created = (await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload: request() })).json();
    const url = `/api/intents/${created.intent.id}/cancel`;
    await app.inject({ method: 'POST', url, headers: headers(config), payload: { mode: 'simulation' } });
    await app.inject({ method: 'POST', url, headers: headers(config), payload: { mode: 'simulation' } });
    const replay = (await app.inject({ method: 'POST', url: '/api/intents', headers: headers(config), payload: request() })).json();
    expect(replay.intent.status).toBe('SIMULATION_CANCELLED'); expect(replay.events).toHaveLength(3);
  });

  it('configuration rejects a non-loopback bind and live mode and rotates tokens on each startup', () => {
    expect(loadHostConfig({}).port).toBe(7073);
    expect(loadHostConfig({}).allowedOrigins.has('http://127.0.0.1:7072')).toBe(true);
    expect(loadHostConfig({}).allowedOrigins.has('http://localhost:7072')).toBe(true);
    expect(loadHostConfig({}).allowedOrigins.has('http://127.0.0.1:7071')).toBe(true);
    expect(loadHostConfig({}).allowedOrigins.has('http://localhost:7071')).toBe(true);
    expect(loadHostConfig({}).allowedOrigins.has('http://127.0.0.1:7070')).toBe(false);
    expect(() => loadHostConfig({ XHH_HOST_BIND: '0.0.0.0' })).toThrow();
    expect(() => loadHostConfig({ XHH_HOST_MODE: 'live' })).toThrow();
    expect(() => loadHostConfig({ XHH_HOST_EXTENSION_IDS: '*' })).toThrow();
    expect(() => loadHostConfig({ XHH_HOST_PORT: '7073oops' })).toThrow();
    expect(loadHostConfig({}).sessionToken).not.toBe(loadHostConfig({}).sessionToken);
  });
});
