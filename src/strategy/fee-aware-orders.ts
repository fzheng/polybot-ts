import type { TradingConfig } from '../config.js';

/**
 * Fee-aware order type selection for Polymarket 15-min markets.
 *
 * Polymarket uses a quadratic taker fee: fee_per_share = p * (1-p) * FEE_RATE
 * where FEE_RATE = 0.0625 (fee_rate_bps=1000 for 15-min crypto markets).
 * Fee peaks at ~1.56% per share at 50/50 odds (~3.12% round-trip).
 * Maker orders (GTC limit) pay 0% fee and earn rebates (20% of taker pool).
 *
 * Strategy:
 * - Leg 1: FOK (speed) only if profit margin > estimated fee, otherwise GTC
 * - Leg 2: Always GTC — we have time to wait for fills and collect rebates
 */
export class FeeAwareOrderPlacer {
  private useMaker: boolean;
  private fallbackToTaker: boolean;
  private takerFeeRate: number;

  constructor(config: TradingConfig) {
    this.useMaker = config.useMakerOrders;
    this.fallbackToTaker = config.makerFallbackToTaker;
    this.takerFeeRate = config.takerFeeRate;
  }

  /**
   * Decide order type for Leg 1 (entry).
   *
   * In a 15-min market with 3-second dip windows, speed matters.
   * But paying 3.15% fee on a 5% margin eats 60%+ of profit.
   *
   * Logic:
   * - If profit margin > taker fee → FOK is fine (speed wins)
   * - If profit margin <= taker fee → GTC limit (fee would eat profit)
   * - If useMakerOrders disabled → always FOK
   */
  decideLeg1OrderType(
    leg1Price: number,
    oppositePrice: number,
    sumTarget: number,
  ): 'GTC' | 'FOK' {
    if (!this.useMaker) return 'FOK';

    const sum = leg1Price + oppositePrice;
    const profitMargin = (sumTarget - sum) / sumTarget;
    const takerFee = this.estimateTakerFee(leg1Price);

    // FOK only if profit margin comfortably exceeds taker fee
    if (this.fallbackToTaker && profitMargin > takerFee * 1.5) {
      return 'FOK';
    }

    return 'GTC';
  }

  /**
   * Decide order type for Leg 2 (hedge).
   * Always GTC — we have time to wait, and maker rebates are free money.
   */
  decideLeg2OrderType(): 'GTC' {
    return 'GTC';
  }

  /**
   * Calculate limit price for a GTC order placed inside the spread.
   *
   * Buy: Place at bestBid + 1 tick (0.01) to be first in queue
   * Sell: Place at bestAsk - 1 tick to be first in queue
   *
   * The tick size on Polymarket is 0.01 (1 cent).
   */
  calculateLimitPrice(
    bestBid: number,
    bestAsk: number,
    side: 'buy' | 'sell',
  ): number {
    const tick = 0.01;
    if (side === 'buy') {
      // Inside the spread, just above best bid
      const price = bestBid + tick;
      // Don't cross the ask
      return Math.min(price, bestAsk - tick);
    } else {
      // Inside the spread, just below best ask
      const price = bestAsk - tick;
      // Don't cross the bid
      return Math.max(price, bestBid + tick);
    }
  }

  /**
   * Estimate taker fee as a fraction of trade cost.
   *
   * Polymarket quadratic fee: fee_per_share = p * (1-p) * FEE_RATE
   * As % of cost (per share price): fee_rate = (1-p) * FEE_RATE
   *
   * This means fee as % of cost is HIGHER at lower prices:
   *   price=0.50 → fee=3.13% of cost ($0.0156/share)
   *   price=0.40 → fee=3.75% of cost ($0.0150/share)
   *   price=0.30 → fee=4.38% of cost ($0.0131/share)
   *   price=0.20 → fee=5.00% of cost ($0.0100/share)
   */
  estimateTakerFee(price: number): number {
    if (price <= 0 || price >= 1) return 0;
    return (1 - price) * this.takerFeeRate;
  }

  /**
   * Calculate the effective cost including estimated fee for a taker order.
   */
  effectiveCost(price: number, shares: number, orderType: 'GTC' | 'FOK'): number {
    const baseCost = price * shares;
    if (orderType === 'GTC') return baseCost; // Maker: no fee
    const feeRate = this.estimateTakerFee(price);
    return baseCost * (1 + feeRate);
  }
}
