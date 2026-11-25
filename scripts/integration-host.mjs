/** HTTP-only dashboard integration fixture. Never imports another project. */
import { mkdtemp, open, lstat, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { loadHostConfig } from '../dist-host/config.js';
import { buildHost } from '../dist-host/server.js';

let app;
let dataDir;
let configPath;
let ownedFile;
let closing;
let input;

async function cleanup() {
  if (closing) return closing;
  closing = (async () => {
    input?.close();
    process.stdin.pause();
    process.stdin.destroy();
    if (app) await app.close();
    if (configPath && ownedFile) {
      const current = await lstat(configPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      // Do not remove a file another process has replaced since our exclusive create.
      if (current?.isFile() && current.ino === ownedFile.ino && current.dev === ownedFile.dev) await unlink(configPath);
    }
    if (dataDir) {
      const prefix = `${resolve(tmpdir())}${sep}xhh-ui-host-test-`;
      if (!resolve(dataDir).startsWith(prefix)) throw new Error('Unsafe integration cleanup target');
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  })();
  return closing;
}
function shutdown() {
  void cleanup().then(() => { if (process.connected) process.disconnect(); }).catch(() => {
    process.stderr.write('UI integration host cleanup failed\n'); process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}

async function main() {
  const requested = process.env.UI_HOST_TEST_CONFIG;
  if (!requested || !isAbsolute(requested)) throw new Error('Absolute UI_HOST_TEST_CONFIG required');
  configPath = resolve(requested);
  dataDir = await mkdtemp(join(tmpdir(), 'xhh-ui-host-test-'));
  const config = loadHostConfig({ XHH_HOST_PORT: '7073', XHH_HOST_DATA_DIR: dataDir, XHH_HOST_MODE: 'simulation' });
  app = buildHost(config);
  // Fixed integration port: fail on conflicts instead of silently selecting another host.
  await app.listen({ host: '127.0.0.1', port: 7073 });
  const file = await open(configPath, 'wx', 0o600);
  try {
    ownedFile = await file.stat();
    await file.writeFile(JSON.stringify({ token: config.sessionToken, hostUrl: 'http://127.0.0.1:7073', dataDir }));
    await file.sync();
  } finally { await file.close(); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => { if (line === 'shutdown') shutdown(); });
  process.on('message', message => { if (message === 'shutdown') shutdown(); });
  process.once('disconnect', shutdown);
  process.stdout.write('UI integration host ready\n');
}

main().catch(async () => {
  process.stderr.write('UI integration host failed; check the config path and port 7073\n');
  process.exitCode = 1;
  await cleanup().catch(() => { process.stderr.write('UI integration host cleanup failed\n'); });
});
