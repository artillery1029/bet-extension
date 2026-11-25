import { loadHostConfig } from './config.js';
import { buildHost } from './server.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const config = loadHostConfig();
  const app = buildHost(config);
  await app.listen({ host: config.bind, port: config.port });
  // An explicit terminal pairing secret, never an HTTP response or request log.
  process.stderr.write(`\nXHH 本地宿主：http://127.0.0.1:${config.port}（仅模拟）\n`);
  process.stderr.write(`本次启动配对密钥：${config.sessionToken}\n`);
  process.stderr.write('请仅粘贴到自家客户端或插件；不要截图分享。重启后旧密钥失效。\n');
  process.stderr.write(`SQLite：${config.databasePath}\n`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch(() => {
  process.stderr.write('本地模拟宿主启动失败。请检查 Node 26、端口、目录权限和宿主配置；未启用实盘。\n');
  process.exitCode = 1;
});
