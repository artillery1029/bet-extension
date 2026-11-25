import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const DEV_ORIGINS = [
  'http://127.0.0.1:7072', 'http://localhost:7072',
  'http://127.0.0.1:7071', 'http://localhost:7071',
] as const;
export interface HostConfig {
  bind: '127.0.0.1';
  port: number;
  databasePath: string;
  sessionToken: string;
  allowedOrigins: ReadonlySet<string>;
}

export function loadHostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  if (env.XHH_HOST_MODE && env.XHH_HOST_MODE !== 'simulation') {
    throw new Error('The local host only supports simulation.');
  }
  if (env.XHH_HOST_BIND && env.XHH_HOST_BIND !== '127.0.0.1') {
    throw new Error('The local host must bind to 127.0.0.1.');
  }
  const rawPort = env.XHH_HOST_PORT ?? '7073';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('XHH_HOST_PORT must be an integer from 1 to 65535.');
  }
  const allowedOrigins = new Set<string>(DEV_ORIGINS);
  const ids = env.XHH_HOST_EXTENSION_IDS?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
  for (const id of ids) {
    if (!/^[a-p]{32}$/.test(id)) throw new Error('Invalid explicit Chrome extension ID.');
    allowedOrigins.add(`chrome-extension://${id}`);
  }
  const appData = env.LOCALAPPDATA ?? resolve(homedir(), '.local', 'share');
  const directory = resolve(env.XHH_HOST_DATA_DIR ?? resolve(appData, 'xhh-bet', 'host'));
  return {
    bind: '127.0.0.1',
    port: Number(rawPort),
    databasePath: resolve(directory, 'intents.sqlite'),
    sessionToken: randomBytes(32).toString('base64url'),
    allowedOrigins,
  };
}
