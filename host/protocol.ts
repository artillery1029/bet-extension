/** Local protocol only. These records never represent platform orders or fills. */
export interface SimulationPosition {
  legId: string;
  venue: 'polymarket' | 'sx' | 'limitless';
  marketId: string;
  label: string;
  levelIndex: number;
  price: string;
  quantity: string;
  stake: string;
  fee: string;
}

export interface SimulationIntentRequest {
  mode: 'simulation';
  idempotencyKey: string;
  scanId: string;
  eventGroupId: string;
  eventLabel: string;
  sourceObservedAt: string;
  /** Quote provenance only; execution mode remains simulation even for live sources. */
  sourceMode?: 'live' | 'replay' | 'demo';
  targetReturn: string;
  estimatedCost: string;
  estimatedMinReturn: string;
  positions: SimulationPosition[];
}

export type SimulationStatus = 'RECORDED' | 'SIMULATED' | 'SIMULATION_CANCELLED';
export interface SimulationIntent {
  id: string;
  status: SimulationStatus;
  request: SimulationIntentRequest;
  createdAt: string;
  updatedAt: string;
  disclaimer: string;
}
export interface SimulationEvent {
  sequence: number;
  intentId: string;
  kind: 'INTENT_RECORDED' | 'SIMULATION_RECORDED' | 'SIMULATION_RECOVERED' | 'SIMULATION_CANCELLED';
  createdAt: string;
  detail: string;
}
export interface IntentDetail {
  intent: SimulationIntent;
  events: SimulationEvent[];
}
export interface IntentList {
  mode: 'simulation';
  items: SimulationIntent[];
  total: number;
  limit: number;
  offset: number;
}
export interface HostHealth {
  service: 'xhh-bet-host';
  status: 'ok';
  mode: 'simulation';
  liveTradingEnabled: false;
  persistence: 'sqlite-wal';
}
export const SIMULATION_DISCLAIMER = '仅本地模拟记录；未向平台发送订单，未签名，未产生真实成交。';
