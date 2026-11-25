/** Isolated local smoke test. Never attaches to an existing Chrome or contacts a venue. */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { buildHost } from '../dist-host/server.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, label) { if (!value) throw new Error(label); }
const directory = await mkdtemp(join(tmpdir(), 'xhh-extension-test-'));
const profile = join(directory, 'chrome-profile');
const extension = join(directory, 'extension');
let app;
let pageServer;
let child;
let socket;
let secrets = [];
const pending = new Map();
const originAudit = [];
let nextId = 0;

function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 8000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function waitFor(run, label, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await run()) return; await delay(80); }
  throw new Error(label);
}
async function evaluate(expression, sessionId) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
  return result.result.value;
}
try {
  // A checked-in protocol fixture deliberately represents replay, never live quotes.
  const replayRequest = JSON.parse(await readFile(new URL('../fixtures/simulation-replay-request.json', import.meta.url), 'utf8'));
  assert(replayRequest.mode === 'simulation' && replayRequest.sourceMode === 'replay', 'Fixture must remain explicitly replay simulation.');
  replayRequest.idempotencyKey = randomBytes(24).toString('hex');
  const earliestQuote = replayRequest.sourceObservedAt;
  pageServer = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><title>Local simulation contract test</title><p>Replay simulation only.</p>');
  });
  await new Promise((resolve, reject) => { pageServer.once('error', reject); pageServer.listen(0, '127.0.0.1', resolve); });
  const uiUrl = `http://127.0.0.1:${pageServer.address().port}`;
  const allowedOrigins = new Set([uiUrl]);
  let sessionToken = randomBytes(32).toString('base64url'); secrets.push(sessionToken);
  const config = { bind: '127.0.0.1', port: 0, databasePath: join(directory, 'data', 'intents.sqlite'), sessionToken, allowedOrigins };
  app = buildHost(config);
  app.server.on('request', request => {
    originAudit.push({ origin: request.headers.origin ?? null, host: request.headers.host, path: request.url });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  // Production remains fixed at 7073. This temporary copy alone uses the random test port.
  await cp(fileURLToPath(new URL('../dist/', import.meta.url)), extension, { recursive: true });
  for (const name of ['types.js', 'manifest.json']) {
    const path = join(extension, name);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('127.0.0.1:7073', `127.0.0.1:${port}`));
  }
  const chrome = process.env.XHH_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  child = spawn(chrome, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let launchError;
  child.once('error', error => { launchError = error; });
  let endpoint;
  await waitFor(async () => {
    if (launchError) throw new Error('Chrome executable could not be started.');
    try { const [debugPort, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); endpoint = `ws://127.0.0.1:${debugPort}${path}`; return true; }
    catch { return false; }
  }, 'Independent Chrome did not expose DevToolsActivePort.');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('Independent CDP connection failed.')), { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data)); const operation = pending.get(message.id);
    if (!operation) return; pending.delete(message.id);
    if (message.error) operation.reject(new Error(`CDP ${message.error.message}`)); else operation.resolve(message.result);
  });
  const loaded = await call('Extensions.loadUnpacked', { path: extension });
  const extensionId = loaded.id;
  assert(/^[a-p]{32}$/.test(extensionId), 'Chrome did not return an extension ID.');
  const { targetId } = await call('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, sessionId);
  await waitFor(() => evaluate(`document.getElementById('extension-id')?.textContent === ${JSON.stringify(extensionId)}`, sessionId), 'Popup did not initialize.');
  const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`, sessionId);
  const pair = async value => {
    await evaluate(`document.getElementById('token').value = ${JSON.stringify(value)}; document.getElementById('pair').click()`, sessionId);
  };
  await pair(sessionToken);
  await waitFor(() => evaluate("document.getElementById('notification').textContent.includes('Origin')", sessionId), 'Unapproved extension origin was not rejected.');
  allowedOrigins.add(`chrome-extension://${extensionId}`);
  await pair('A'.repeat(43));
  await waitFor(() => evaluate("document.getElementById('notification').textContent.includes('密钥无效')", sessionId), 'Wrong pairing token was not rejected.');
  await pair(sessionToken);
  await waitFor(() => evaluate("!document.getElementById('demo').disabled", sessionId), 'Real extension could not pair with loopback host.');
  await click('demo');
  await waitFor(() => evaluate("document.querySelector('.badge')?.textContent === 'SIMULATED'", sessionId), 'Simulation was not visible in the extension.');
  const headers = () => ({ Origin: uiUrl, Authorization: `Bearer ${sessionToken}` });
  const list = async () => await (await fetch(`http://127.0.0.1:${port}/api/intents`, { headers: headers() })).json();
  let records = await list();
  assert(records.total === 1, 'Expected exactly one saved simulation.');
  // Recreate a lost acknowledgement using the original durable request; retry must reuse its ID.
  const firstId = records.items[0].id;
  await evaluate(`chrome.storage.local.set({ pendingDemoSimulation: ${JSON.stringify(records.items[0].request)} })`, sessionId);
  await call('Page.reload', {}, sessionId);
  await waitFor(() => evaluate("Boolean(document.getElementById('retry')) && !document.getElementById('retry').disabled", sessionId), 'Pending simulation was not recovered from extension storage.');
  await click('retry');
  await waitFor(() => evaluate("document.getElementById('notification').textContent.includes('原模拟意图已获确认')", sessionId), 'Idempotent retry did not acknowledge the original intent.');
  records = await list();
  assert(records.total === 1 && records.items[0].id === firstId, 'Retry created a duplicate simulation.');
  await evaluate("[...document.querySelectorAll('button')].find(x => x.textContent === '标记模拟取消').click()", sessionId);
  await waitFor(() => evaluate("document.querySelector('.badge')?.textContent === 'SIMULATION_CANCELLED'", sessionId), 'Local cancellation was not recorded.');
  // The independent page sends the saved HTTP contract; no sibling project runs here.
  const webTarget = await call('Target.createTarget', { url: uiUrl });
  const webSession = await call('Target.attachToTarget', { targetId: webTarget.targetId, flatten: true });
  await call('Runtime.enable', {}, webSession.sessionId);
  await waitFor(() => evaluate(`location.origin === ${JSON.stringify(uiUrl)} && document.readyState === 'complete'`, webSession.sessionId), 'The isolated local contract page did not load.');
  const submitExpression = `(async () => { const response = await fetch(${JSON.stringify(`http://127.0.0.1:${port}/api/intents`)}, { method: 'POST', headers: { Authorization: ${JSON.stringify(`Bearer ${sessionToken}`)}, 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(replayRequest))} }); return { status: response.status, data: await response.json() }; })()`;
  const submitted = await evaluate(submitExpression, webSession.sessionId);
  assert(submitted.status === 201 && submitted.data.intent.status === 'SIMULATED', 'The replay contract fixture was not accepted as simulation.');
  assert(JSON.stringify(submitted.data.intent.request.positions) === JSON.stringify(replayRequest.positions), 'Contract position precision changed during simulation submission.');
  assert(submitted.data.intent.request.sourceMode === 'replay' && submitted.data.intent.request.sourceObservedAt === earliestQuote, 'Historical quote provenance changed during simulation submission.');
  const retried = await evaluate(submitExpression, webSession.sessionId);
  assert(retried.status === 200 && retried.data.intent.id === submitted.data.intent.id, 'Dev-page retry duplicated the actual replay intent.');
  await click('refresh');
  await waitFor(() => evaluate(`[...document.querySelectorAll('.intent strong')].some(value => value.textContent === ${JSON.stringify(replayRequest.eventLabel)})`, sessionId), 'The extension did not show the same dev-page replay simulation.');
  assert(await evaluate("document.getElementById('intents').textContent.includes('历史回放')", sessionId), 'The extension did not mark historical replay provenance.');
  records = await list();
  assert(records.total === 2 && records.items.some(value => value.request.scanId === replayRequest.scanId), 'The saved replay intent was missing.');
  await app.close();
  const oldToken = sessionToken;
  sessionToken = randomBytes(32).toString('base64url'); secrets.push(sessionToken);
  app = buildHost({ ...config, port, sessionToken });
  await app.listen({ host: '127.0.0.1', port });
  const rejected = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { ...headers(), Authorization: `Bearer ${oldToken}` } });
  assert(rejected.status === 401, 'Old token survived host restart.');
  await click('refresh');
  await waitFor(() => evaluate("document.getElementById('notification').textContent.includes('密钥无效')", sessionId), 'Extension did not detect token rotation.');
  await pair(sessionToken);
  await waitFor(() => evaluate("[...document.querySelectorAll('.badge')].some(value => value.textContent === 'SIMULATION_CANCELLED') && document.querySelectorAll('.intent').length === 2", sessionId), 'Persisted simulation was lost after host restart.');
  console.log(JSON.stringify({ passed: true, isolatedChrome: true, randomLoopbackPort: true, extensionOriginGuard: true, badTokenRejected: true,
    simulationRecorded: true, persistedOutboxRetryNoDuplicate: true, localCancellation: true, selfContainedReplayContractSubmission: true,
    exactContractPositionsPreserved: true, extensionShowsSameReplayIntent: true, databaseRestartRecovery: true, oldTokenRejected: true }));
} catch (error) {
  let message = error instanceof Error ? error.message : 'Browser smoke test failed.';
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  console.error(message);
  console.error(JSON.stringify({ originAudit: originAudit.slice(-12) }));
  process.exitCode = 1;
} finally {
  if (socket?.readyState === 1) { await call('Browser.close').catch(() => {}); socket.close(); }
  if (child && child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]); if (child.exitCode === null) child.kill(); }
  if (app) await app.close();
  if (pageServer) await new Promise(resolve => pageServer.close(resolve));
  for (const operation of pending.values()) operation.reject(new Error('Test completed.'));
  pending.clear();
  const prefix = `${resolve(tmpdir())}${sep}xhh-extension-test-`;
  if (!resolve(directory).startsWith(prefix)) throw new Error('Unsafe smoke-test cleanup target.');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
