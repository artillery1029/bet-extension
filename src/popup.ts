import { HOST_URL } from './types.js';
import type { Intent, List, Message, Reply, Status } from './types.js';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value as T;
}
const notification = element('notification');
const pairButton = element<HTMLButtonElement>('pair');
const disconnectButton = element<HTMLButtonElement>('disconnect');
const refreshButton = element<HTMLButtonElement>('refresh');
const demoButton = element<HTMLButtonElement>('demo');
const retryButton = element<HTMLButtonElement>('retry');
let offset = 0;
let total = 0;
let connected = false;
let pending = false;
let busy = false;

async function send<T>(message: Message): Promise<T> {
  const result = await chrome.runtime.sendMessage(message) as Reply;
  if (!result || !result.ok) throw new Error(result && !result.ok ? result.error : '插件宿主连接不可用。');
  return result.value as T;
}
function controls() {
  pairButton.disabled = busy;
  disconnectButton.disabled = busy || !connected;
  refreshButton.disabled = busy || !connected;
  demoButton.disabled = busy || !connected || pending;
  retryButton.disabled = busy || !connected || !pending;
  element<HTMLButtonElement>('previous').disabled = busy || !connected || offset === 0;
  element<HTMLButtonElement>('next').disabled = busy || !connected || offset + 20 >= total;
}
async function status() {
  const state = await send<Status>({ type: 'STATUS' });
  connected = state.paired; pending = state.pending;
  element('extension-id').textContent = state.extensionId;
  element('connection').textContent = connected ? '已配对 · 刷新可检查宿主' : '尚未配对';
  element('connection').dataset.connected = String(connected);
  element('pending').textContent = pending ? '有一条未确认的模拟请求，重试会复用原幂等键。' : '没有待重试的模拟请求。';
  controls();
}
function row(intent: Intent) {
  const item = document.createElement('article'); item.className = 'intent';
  const title = document.createElement('strong'); title.textContent = intent.request.eventLabel;
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = intent.status;
  const id = document.createElement('div'); id.className = 'mono secondary'; id.textContent = intent.id;
  const description = document.createElement('p'); description.className = 'secondary';
  description.textContent = `${intent.request.positions.length} 条模拟头寸 · 估算成本 ${intent.request.estimatedCost} · ${new Date(intent.createdAt).toLocaleString('zh-CN')}`;
  const provenance = document.createElement('p'); provenance.className = 'secondary';
  const source = intent.request.sourceMode === 'replay' ? '历史回放' : intent.request.sourceMode === 'live' ? '实时来源（仍仅模拟）' : intent.request.sourceMode === 'demo' ? '本地虚构演示' : '来源未标记';
  provenance.textContent = `${source} · 原报价 ${new Date(intent.request.sourceObservedAt).toLocaleString('zh-CN')}`;
  const detail = document.createElement('button'); detail.className = 'small'; detail.textContent = '查看模拟事件';
  detail.onclick = () => { void action(async () => { const data = await send({ type: 'DETAIL', id: intent.id }); element('details').textContent = JSON.stringify(data, null, 2); }); };
  const cancel = document.createElement('button'); cancel.className = 'small'; cancel.textContent = '标记模拟取消';
  cancel.disabled = intent.status === 'SIMULATION_CANCELLED';
  cancel.onclick = () => { void action(async () => { await send({ type: 'CANCEL_SIMULATION', id: intent.id }); notification.textContent = '已标记本地模拟取消；未发生平台撤单。'; await refresh(); }); };
  const buttons = document.createElement('div'); buttons.className = 'actions'; buttons.append(detail, cancel);
  item.append(title, badge, id, description, provenance, buttons); return item;
}
async function refresh() {
  const list = await send<List>({ type: 'LIST', offset });
  total = list.total;
  const target = element('intents'); target.replaceChildren(...list.items.map(row));
  if (!list.items.length) { const empty = document.createElement('p'); empty.className = 'secondary'; empty.textContent = '暂无本地模拟意图。'; target.append(empty); }
  element('count').textContent = `共 ${total} 条 · 本页 ${list.items.length} 条`;
  element('connection').textContent = '宿主在线 · 仅本地模拟';
  controls();
}
async function action(run: () => Promise<void>) {
  if (busy) return;
  busy = true; notification.textContent = ''; controls();
  try { await run(); }
  catch (error) { notification.textContent = error instanceof Error ? error.message : '操作失败。'; }
  finally { busy = false; await status().catch(() => {}); controls(); }
}

element('host-url').textContent = HOST_URL;
pairButton.onclick = () => { void action(async () => {
  const input = element<HTMLInputElement>('token');
  await send({ type: 'PAIR', token: input.value.trim() }); input.value = ''; offset = 0; await status(); await refresh();
}); };
disconnectButton.onclick = () => { void action(async () => { await send({ type: 'DISCONNECT' }); element('intents').replaceChildren(); element('details').textContent = ''; notification.textContent = '已移除会话密钥，待确认模拟请求仍保留。'; }); };
refreshButton.onclick = () => { void action(refresh); };
demoButton.onclick = () => { void action(async () => {
  await send({ type: 'CREATE_DEMO', key: crypto.randomUUID() });
  notification.textContent = '已保存本地演示模拟；未使用平台行情、未签名、未下单。'; offset = 0; await refresh();
}); };
retryButton.onclick = () => { void action(async () => { await send({ type: 'RETRY_PENDING' }); notification.textContent = '原模拟意图已获确认；未创建新的执行意图。'; await refresh(); }); };
element<HTMLButtonElement>('previous').onclick = () => { void action(async () => { offset = Math.max(0, offset - 20); await refresh(); }); };
element<HTMLButtonElement>('next').onclick = () => { void action(async () => { offset += 20; await refresh(); }); };
void action(async () => { await status(); if (connected) await refresh(); });
