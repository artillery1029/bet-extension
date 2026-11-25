import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { HostConfig } from './config.js';
import type { HostHealth, SimulationIntentRequest } from './protocol.js';
import { IntentConflict, IntentNotFound, IntentStore } from './store.js';

const decimal = { type: 'string', maxLength: 64, pattern: '^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,48})?$' } as const;
const identifier = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_.:/-]+$' } as const;
const label = { type: 'string', minLength: 1, maxLength: 240 } as const;
export const intentSchema = {
  type: 'object', additionalProperties: false,
  required: ['mode', 'idempotencyKey', 'scanId', 'eventGroupId', 'eventLabel', 'sourceObservedAt', 'targetReturn', 'estimatedCost', 'estimatedMinReturn', 'positions'],
  properties: {
    mode: { type: 'string', const: 'simulation' },
    idempotencyKey: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]+$' },
    scanId: identifier, eventGroupId: identifier, eventLabel: label,
    sourceObservedAt: { type: 'string', minLength: 20, maxLength: 30, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' },
    sourceMode: { type: 'string', enum: ['live', 'replay', 'demo'] },
    targetReturn: decimal, estimatedCost: decimal, estimatedMinReturn: decimal,
    positions: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object', additionalProperties: false,
        required: ['legId', 'venue', 'marketId', 'label', 'levelIndex', 'price', 'quantity', 'stake', 'fee'],
        properties: {
          legId: identifier, venue: { type: 'string', enum: ['polymarket', 'sx', 'limitless'] }, marketId: identifier, label,
          levelIndex: { type: 'integer', minimum: 0, maximum: 10000 },
          price: decimal, quantity: decimal, stake: decimal, fee: decimal,
        },
      },
    },
  },
} as const;

const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' } } } as const;

function positive(value: string): boolean { return !/^0(?:\.0+)?$/.test(value); }
function validUtc(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
}

export function buildHost(config: HostConfig) {
  if (config.bind !== '127.0.0.1') throw new Error('Loopback binding is mandatory.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.sessionToken)) throw new Error('A random 256-bit session token is required.');
  const store = new IntentStore(config.databasePath);
  try { store.recover(); } catch (error) { store.close(); throw error; }
  const app = Fastify({
    logger: false, trustProxy: false, bodyLimit: 64 * 1024,
    requestTimeout: 15_000, connectionTimeout: 10_000, exposeHeadRoutes: false,
    ajv: { customOptions: { coerceTypes: false, useDefaults: false, removeAdditional: false } },
  });
  app.addHook('onClose', async () => store.close());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const remote = request.ip;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ error: 'LOOPBACK_REQUIRED' });
    }
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : config.port;
    if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) {
      return reply.code(403).send({ error: 'HOST_NOT_ALLOWED' });
    }
    const browserOrigin = request.headers.origin;
    const extensionId = request.headers['x-xhh-extension-id'];
    // Chrome's privileged extension fetch can omit Origin. This declaration is
    // not authentication: it still requires an explicitly allowed ID AND the
    // random Bearer secret. A present browser Origin always takes precedence.
    const declaredExtension = typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId)
      ? `chrome-extension://${extensionId}` : undefined;
    const origin = typeof browserOrigin === 'string' ? browserOrigin : declaredExtension;
    if (!origin || !config.allowedOrigins.has(origin)
      || (extensionId !== undefined && declaredExtension !== origin)) {
      return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
    }
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      const method = request.headers['access-control-request-method'];
      const headers = request.headers['access-control-request-headers'];
      const requestedHeaders = typeof headers === 'string' ? headers.toLowerCase().split(',').map(value => value.trim()) : [];
      if (!['GET', 'POST'].includes(String(method)) || requestedHeaders.some(value => !['authorization', 'content-type', 'x-xhh-extension-id'].includes(value))) {
        return reply.code(403).send({ error: 'PREFLIGHT_NOT_ALLOWED' });
      }
      return reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Xhh-Extension-Id')
        .header('Access-Control-Max-Age', '600').code(204).send();
    }
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.sessionToken}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return reply.code(401).send({ error: 'PAIRING_REQUIRED', message: '请使用本次宿主启动生成的配对密钥。' });
    }
  });

  app.options('/*', async (_request, reply) => reply.code(204).send());
  app.get('/api/health', async (): Promise<HostHealth> => ({
    service: 'xhh-bet-host', status: 'ok', mode: 'simulation', liveTradingEnabled: false, persistence: 'sqlite-wal',
  }));
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/intents', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'string', pattern: '^([1-9][0-9]?|100)$' },
      offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,6})$' },
    } } },
  }, async request => store.list(Number(request.query.limit ?? 50), Number(request.query.offset ?? 0)));
  app.get<{ Params: { id: string } }>('/api/intents/:id', { schema: { params: idParams } }, async request => store.detail(request.params.id));
  app.post<{ Body: SimulationIntentRequest }>('/api/intents', { schema: { body: intentSchema } }, async (request, reply) => {
    const body = request.body;
    if (body.mode !== 'simulation') return reply.code(400).send({ error: 'ONLY_SIMULATION_ALLOWED' });
    const unique = new Set(body.positions.map(position => `${position.legId}:${position.levelIndex}`));
    if (!validUtc(body.sourceObservedAt) || !positive(body.targetReturn) || !body.eventLabel.trim()
      || unique.size !== body.positions.length
      || body.positions.some(position => !/^0\.[0-9]+$/.test(position.price) || !positive(position.price) || !positive(position.quantity) || !position.label.trim())) {
      return reply.code(400).send({ error: 'INVALID_SIMULATION_REQUEST' });
    }
    const { intent, reused } = store.record(body);
    store.complete(intent.id);
    return reply.code(reused ? 200 : 201).send({ ...store.detail(intent.id), reused });
  });
  app.post<{ Params: { id: string } }>('/api/intents/:id/cancel', {
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', const: 'simulation' } } } },
  }, async request => store.cancel(request.params.id));

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'NOT_FOUND' }));
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof IntentConflict) return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
    if (error instanceof IntentNotFound) return reply.code(404).send({ error: 'INTENT_NOT_FOUND' });
    const problem = error as { validation?: unknown; statusCode?: number };
    if (problem.validation || problem.statusCode === 400) return reply.code(400).send({ error: 'VALIDATION_FAILED', message: '仅支持字段合法的 simulation 请求。' });
    if (problem.statusCode === 413) return reply.code(413).send({ error: 'REQUEST_TOO_LARGE' });
    if (problem.statusCode === 415) return reply.code(415).send({ error: 'JSON_REQUIRED' });
    // Never serialize request bodies, Authorization headers, or low-level errors.
    return reply.code(503).send({ error: 'HOST_UNAVAILABLE' });
  });
  return app;
}
