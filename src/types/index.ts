export type TradeAction = "buy" | "sell" | "hold";

export interface TradeDecision {
  asset: string;
  action: TradeAction;
  allocation_usd: number;
  tp_price: number | null;
  sl_price: number | null;
  exit_plan: string;
  rationale: string;
}

export interface AgentDecisionResult {
  reasoning: string;
  trade_decisions: TradeDecision[];
}

export interface ActiveTrade {
  asset: string;
  is_long: boolean;
  amount: number;
  entry_price: number;
  tp_oid: number | null;
  sl_oid: number | null;
  exit_plan: string;
  opened_at: string;
}

export interface EnrichedPosition {
  coin: string;
  szi: number;
  entryPx: number;
  pnl: number;
  liquidationPx?: number | null;
  liqPx?: number | null;
  leverage?: unknown;
}

export interface UserState {
  balance: number;
  total_value: number;
  positions: EnrichedPosition[];
}

export interface OpenOrder {
  coin?: string;
  oid?: number;
  isBuy?: boolean;
  sz?: number;
  px?: number;
  triggerPx?: number;
  orderType?: unknown;
}

export interface FillEntry {
  time?: number | string;
  timestamp?: number | string;
  coin?: string;
  asset?: string;
  isBuy?: boolean;
  sz?: number | string;
  size?: number | string;
  px?: number | string;
  price?: number | string;
}

export interface CliArgs {
  assets: string[];
  interval: string;
}
