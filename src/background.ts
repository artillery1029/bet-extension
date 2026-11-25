import { HOST_URL, isIntent, record } from './types.js';
import type { Message } from './types.js';

const TOKEN_KEY = 'hostSessionToken';
const PENDING_KEY = 'pendingDemoSimulation';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeStorage = Promise.all([
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);

async function token(): Promise<string> {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  if (typeof stored[TOKEN_KEY] !== 'string') throw new Error('请先使用本次宿主启动的密钥配对。');
  return stored[TOKEN_KEY];
}

async function fetchHost(path: string, method = 'GET', body?: unknown, explicitToken?: string): Promise<unknown> {
  const secret = explicitToken ?? await token();
  let response: Response;
  try {
    response = await fetch(`${HOST_URL}${path}`, {
      method, mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${secret}`, 'X-Xhh-Extension-Id': chrome.runtime.id, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('未收到宿主确认。请检查7073端口、Origin配置和本机网络；模拟请求可使用相同意图重试。');
  }
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: '模拟请求不符合协议，宿主已拒绝。', 401: '配对密钥无效；宿主重启后需要重新配对。',
      403: '插件Origin未获允许；请将本插件ID加入宿主 XHH_HOST_EXTENSION_IDS 后重启配对。',
      404: '本地模拟记录不存在。', 409: '幂等键已用于不同请求，宿主已拒绝重复创建。', 503: '宿主暂不可用，未确认的模拟意图仍保留。',
    };
    throw new Error(messages[response.status] ?? `宿主拒绝请求（HTTP ${response.status}）。`);
  }
  try { return await response.json(); } catch { throw new Error('宿主返回了无效响应；未确认模拟意图仍保留。'); }
}

async function checkHealth(explicitToken?: string): Promise<unknown> {
  const result = await fetchHost('/api/health', 'GET', undefined, explicitToken);
  if (!record(result) || result.service !== 'xhh-bet-host' || result.mode !== 'simulation' || result.liveTradingEnabled !== false || result.status !== 'ok') {
    throw new Error('宿主未声明 simulation-only，已拒绝连接。');
  }
  return result;
}

async function pending(): Promise<unknown> { return (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY]; }

async function submitPending(): Promise<unknown> {
  const request = await pending();
  if (!record(request) || request.mode !== 'simulation') throw new Error('没有待重试的本地模拟请求。');
  const result = await fetchHost('/api/intents', 'POST', request);
  if (!record(result) || !isIntent(result.intent)) throw new Error('响应无法确认为本地模拟意图，已保留原请求。');
  await chrome.storage.local.remove(PENDING_KEY);
  return result;
}

function makeDemo(key: string) {
  return {
    mode: 'simulation', idempotencyKey: key, scanId: 'DEMO_LOCAL_ONLY', eventGroupId: 'DEMO_NO_PLATFORM_EVENT',
    eventLabel: '本地连接演示（无平台行情）', sourceObservedAt: new Date().toISOString(), sourceMode: 'demo',
    targetReturn: '100', estimatedCost: '100', estimatedMinReturn: '100',
    positions: [
      { legId: 'DEMO_A', venue: 'polymarket', marketId: 'DEMO_NOT_AN_ORDER', label: '虚构演示 A', levelIndex: 0, price: '0.5', quantity: '100', stake: '50', fee: '0' },
      { legId: 'DEMO_B', venue: 'sx', marketId: 'DEMO_NOT_AN_ORDER', label: '虚构演示 B', levelIndex: 0, price: '0.5', quantity: '100', stake: '50', fee: '0' },
    ],
  };
}

async function handle(value: unknown): Promise<unknown> {
  await safeStorage;
  if (!record(value) || typeof value.type !== 'string') throw new Error('未知插件请求。');
  const message = value as unknown as Message;
  switch (message.type) {
    case 'STATUS': {
      const stored = await chrome.storage.session.get(TOKEN_KEY);
      return { paired: typeof stored[TOKEN_KEY] === 'string', hostUrl: HOST_URL, extensionId: chrome.runtime.id, pending: Boolean(await pending()) };
    }
    case 'PAIR':
      if (typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) throw new Error('请输入完整的本次宿主配对密钥。');
      await checkHealth(message.token);
      await chrome.storage.session.set({ [TOKEN_KEY]: message.token });
      return { paired: true };
    case 'DISCONNECT':
      await chrome.storage.session.remove(TOKEN_KEY);
      return { paired: false };
    case 'LIST': {
      if (!Number.isInteger(message.offset) || message.offset < 0 || message.offset > 1_000_000) throw new Error('无效分页。');
      await checkHealth();
      const list = await fetchHost(`/api/intents?limit=20&offset=${message.offset}`);
      if (!record(list) || list.mode !== 'simulation' || !Array.isArray(list.items) || !list.items.every(isIntent)) throw new Error('宿主返回的列表不符合仅模拟协议。');
      return list;
    }
    case 'DETAIL':
      if (!uuid.test(message.id)) throw new Error('无效模拟意图ID。');
      return fetchHost(`/api/intents/${message.id}`);
    case 'CREATE_DEMO':
      if (!uuid.test(message.key)) throw new Error('无效幂等键。');
      if (await pending()) throw new Error('先重试上一次未确认的模拟请求，避免创建重复演示。');
      await checkHealth();
      // Preserve the exact request BEFORE sending; restart/retry reuses the same key and body.
      await chrome.storage.local.set({ [PENDING_KEY]: makeDemo(message.key) });
      return submitPending();
    case 'RETRY_PENDING':
      await checkHealth();
      return submitPending();
    case 'CANCEL_SIMULATION':
      if (!uuid.test(message.id)) throw new Error('无效模拟意图ID。');
      await checkHealth();
      return fetchHost(`/api/intents/${message.id}/cancel`, 'POST', { mode: 'simulation' });
    default:
      throw new Error('插件只支持本机健康检查和本地模拟记录。');
  }
}

// Serialize state changes so double clicks cannot overwrite an unacknowledged request.
let queue: Promise<void> = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) {
    respond({ ok: false, error: '仅允许本插件弹窗调用。' });
    return;
  }
  queue = queue.then(async () => {
    try { respond({ ok: true, value: await handle(message) }); }
    catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : '本地模拟请求失败。' }); }
  });
  return true;
});
