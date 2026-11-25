export const HOST_URL = 'http://127.0.0.1:7073';
export type Message =
  | { type: 'STATUS' }
  | { type: 'PAIR'; token: string }
  | { type: 'DISCONNECT' }
  | { type: 'LIST'; offset: number }
  | { type: 'DETAIL'; id: string }
  | { type: 'CREATE_DEMO'; key: string }
  | { type: 'RETRY_PENDING' }
  | { type: 'CANCEL_SIMULATION'; id: string };
export interface Intent {
  id: string;
  status: 'RECORDED' | 'SIMULATED' | 'SIMULATION_CANCELLED';
  createdAt: string;
  disclaimer: string;
  request: {
    mode: 'simulation'; eventLabel: string; scanId: string;
    sourceMode?: 'live' | 'replay' | 'demo'; sourceObservedAt: string;
    estimatedCost: string; targetReturn: string; estimatedMinReturn: string;
    positions: unknown[];
  };
}
export interface List { mode: 'simulation'; items: Intent[]; total: number; limit: number; offset: number; }
export interface Status { paired: boolean; hostUrl: string; extensionId: string; pending: boolean; }
export type Reply = { ok: true; value: unknown } | { ok: false; error: string };

export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function isIntent(value: unknown): value is Intent {
  return record(value) && typeof value.id === 'string' && ['RECORDED', 'SIMULATED', 'SIMULATION_CANCELLED'].includes(String(value.status))
    && typeof value.createdAt === 'string' && typeof value.disclaimer === 'string' && record(value.request)
    && value.request.mode === 'simulation' && typeof value.request.eventLabel === 'string'
    && typeof value.request.sourceObservedAt === 'string' && (value.request.sourceMode === undefined || ['live', 'replay', 'demo'].includes(String(value.request.sourceMode)))
    && typeof value.request.scanId === 'string' && typeof value.request.estimatedCost === 'string'
    && typeof value.request.targetReturn === 'string' && typeof value.request.estimatedMinReturn === 'string' && Array.isArray(value.request.positions);
}
