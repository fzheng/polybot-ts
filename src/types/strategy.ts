import Decimal from 'decimal.js';

export enum Side {
  UP = 'UP',
  DOWN = 'DOWN',
}

export enum StrategyState {
  WATCHING = 'WATCHING',
  LEG1_PENDING = 'LEG1_PENDING',
  WAITING_FOR_HEDGE = 'WAITING_FOR_HEDGE',
  LEG2_PENDING = 'LEG2_PENDING',
  COMPLETED = 'COMPLETED',
  EMERGENCY_EXIT = 'EMERGENCY_EXIT',
  LIQUIDATING = 'LIQUIDATING',
}

export interface LegInfo {
  side: Side;
  price: Decimal;
  shares: Decimal;
  tokenId: string;
  timestamp: Date;
  orderType: 'GTC' | 'FOK';
  bestBid?: Decimal;
  bestAsk?: Decimal;
  orderId?: string;
}

export interface PricePoint {
  price: Decimal;
  timestamp: number; // ms epoch
}

export interface CycleResult {
  roundSlug: string;
  leg1: LegInfo;
  leg2: LegInfo | null;
  totalCost: Decimal;
  payout: Decimal;
  profit: Decimal;
  profitPct: Decimal;
  status: 'completed' | 'emergency_exit' | 'abandoned' | 'early_liquidation';
  completedAt: Date;
}

export interface StrategyStats {
  cyclesCompleted: number;
  cyclesAbandoned: number;
  cyclesWon: number;
  totalProfit: Decimal;
  winRate: number;
  emergencyExits: number;
}
