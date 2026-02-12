import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import Decimal from 'decimal.js';
import type { PaperConfig, TradingConfig } from '../config.js';
import { Side, type LegInfo, type CycleResult } from '../types/strategy.js';

interface Position {
  tokenId: string;
  side: Side;
  shares: Decimal;
  avgPrice: Decimal;
  roundSlug: string;
  timestamp: Date;
}

interface TradeRecord {
  id: string;
  timestamp: string;
  side: string;
  shares: string;
  price: string;
  fee: string;
  orderType: string;
  roundSlug: string;
  balanceAfter: string;
}

/**
 * Paper trading simulator with fee-aware cost tracking.
 *
 * Uses Polymarket's actual quadratic taker fee model:
 *   fee_per_share = price * (1 - price) * FEE_RATE
 * where FEE_RATE = 0.0625 for 15-min crypto markets (fee_rate_bps=1000).
 * Maker (GTC) orders = 0% fee. Maker rebates are NOT simulated.
 */
export class PaperTrader extends EventEmitter {
  private balance: Decimal;
  private startingBalance: Decimal;
  private positions: Map<string, Position> = new Map();
  private history: CycleResult[] = [];
  private config: PaperConfig;
  private takerFeeRate: number;

  constructor(paperConfig: PaperConfig, tradingConfig: TradingConfig) {
    super();
    this.config = paperConfig;
    this.balance = new Decimal(paperConfig.startingBalance);
    this.startingBalance = new Decimal(paperConfig.startingBalance);
    this.takerFeeRate = tradingConfig.takerFeeRate;
  }

  /**
   * Simulate buying shares. Deducts cost + estimated fee from balance.
   *
   * Slippage model (Issue 2):
   * - FOK (taker): fills at bestAsk + size-scaled slippage (models walking the book)
   * - GTC (maker): fills at limit price (zero slippage — you post the price)
   * - Fallback: static slippage if no book data available
   */
  async buy(leg: LegInfo, roundSlug: string): Promise<boolean> {
    const cost = leg.price.times(leg.shares);
    const fee = this.calculateFee(leg.price.toNumber(), leg.shares.toNumber(), leg.orderType);
    const totalCost = cost.plus(fee);

    if (totalCost.greaterThan(this.balance)) {
      this.emit('log', {
        message: `Insufficient balance: need $${totalCost.toFixed(4)}, have $${this.balance.toFixed(4)}`,
        timestamp: new Date(),
        level: 'error',
      });
      return false;
    }

    // Apply slippage based on order type and available book data
    let effectivePrice = leg.price;
    if (this.config.simulateSlippage) {
      if (leg.bestBid && leg.bestAsk && leg.orderType === 'FOK') {
        // Spread-based slippage: FOK taker buys fill at the ask, not the mid
        // Plus additional slippage proportional to order size (models walking the book)
        const spreadSlip = leg.bestAsk.minus(leg.price);
        const sizeSlip = leg.price.times(this.config.slippagePct)
          .times(leg.shares.dividedBy(50)); // 50 shares = base slippage
        effectivePrice = leg.price.plus(spreadSlip).plus(sizeSlip);
        // Cap at ask + 2% (worst case taker fill in thin book)
        const maxPrice = leg.bestAsk.times(1.02);
        if (effectivePrice.greaterThan(maxPrice)) {
          effectivePrice = maxPrice;
        }
      } else if (leg.orderType === 'GTC') {
        // GTC (maker) orders fill AT the limit price — zero slippage
        effectivePrice = leg.price;
      } else {
        // Fallback: static slippage when no book data available
        const slip = leg.price.times(this.config.slippagePct);
        effectivePrice = leg.price.plus(slip);
      }
    }

    const effectiveCost = effectivePrice.times(leg.shares).plus(fee);
    this.balance = this.balance.minus(effectiveCost);

    // Track position
    const posKey = `${roundSlug}:${leg.side}`;
    const existing = this.positions.get(posKey);
    if (existing) {
      const totalShares = existing.shares.plus(leg.shares);
      const totalCostBasis = existing.avgPrice.times(existing.shares)
        .plus(effectivePrice.times(leg.shares));
      existing.avgPrice = totalCostBasis.dividedBy(totalShares);
      existing.shares = totalShares;
    } else {
      this.positions.set(posKey, {
        tokenId: leg.tokenId,
        side: leg.side,
        shares: leg.shares,
        avgPrice: effectivePrice,
        roundSlug,
        timestamp: new Date(),
      });
    }

    // Log trade
    await this.logTrade({
      id: `t-${Date.now()}`,
      timestamp: new Date().toISOString(),
      side: leg.side,
      shares: leg.shares.toString(),
      price: effectivePrice.toString(),
      fee: fee.toString(),
      orderType: leg.orderType,
      roundSlug,
      balanceAfter: this.balance.toString(),
    });

    this.emit('trade', { side: leg.side, shares: leg.shares, price: effectivePrice, fee, roundSlug });
    return true;
  }

  /**
   * Simulate selling shares at market. Credits proceeds minus fee to balance.
   * Used for early liquidation and emergency exits.
   */
  async sell(
    tokenId: string,
    side: Side,
    shares: Decimal,
    sellPrice: Decimal,
    roundSlug: string,
  ): Promise<Decimal> {
    const proceeds = sellPrice.times(shares);
    const fee = this.calculateFee(sellPrice.toNumber(), shares.toNumber(), 'FOK');
    const netProceeds = proceeds.minus(fee);

    this.balance = this.balance.plus(netProceeds);

    // Remove position tracking
    const posKey = `${roundSlug}:${side}`;
    this.positions.delete(posKey);

    await this.logTrade({
      id: `t-${Date.now()}`,
      timestamp: new Date().toISOString(),
      side: `SELL_${side}`,
      shares: shares.toString(),
      price: sellPrice.toString(),
      fee: fee.toString(),
      orderType: 'FOK',
      roundSlug,
      balanceAfter: this.balance.toString(),
    });

    this.emit('trade', { side: `SELL_${side}`, shares, price: sellPrice, fee, roundSlug });
    return netProceeds;
  }

  /**
   * Settle a round. Winning side gets $1/share, losing side gets $0.
   */
  async settleRound(roundSlug: string, winningSide: Side): Promise<Decimal> {
    let payout = new Decimal(0);
    const keysToDelete: string[] = [];

    for (const [key, pos] of this.positions) {
      if (pos.roundSlug !== roundSlug) continue;
      if (pos.side === winningSide) {
        payout = payout.plus(pos.shares); // $1 per winning share
      }
      keysToDelete.push(key);
    }

    for (const key of keysToDelete) {
      this.positions.delete(key);
    }

    this.balance = this.balance.plus(payout);

    this.emit('settled', { roundSlug, winningSide, payout });
    return payout;
  }

  /**
   * Record a completed cycle (both legs or emergency exit).
   */
  recordCycle(result: CycleResult): void {
    this.history.push(result);
  }

  /**
   * Abandon all positions for a round (round end with no settlement).
   */
  abandonRound(roundSlug: string): void {
    const keysToDelete: string[] = [];
    for (const [key, pos] of this.positions) {
      if (pos.roundSlug === roundSlug) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.positions.delete(key);
    }
  }

  // ── Fee Calculation ──────────────────────────────────────────────────

  /**
   * Calculate fee based on order type and price.
   * GTC (maker) = 0% fee
   * FOK (taker) = quadratic: shares * price * (1 - price) * FEE_RATE
   */
  private calculateFee(price: number, shares: number, orderType: string): Decimal {
    if (!this.config.simulateFees) return new Decimal(0);
    if (orderType === 'GTC') return new Decimal(0); // Maker = no fee

    // Polymarket quadratic taker fee: fee = shares * p * (1-p) * FEE_RATE
    const feePerShare = price * (1 - price) * this.takerFeeRate;
    return new Decimal(shares * feePerShare);
  }

  // ── Trade Logging ────────────────────────────────────────────────────

  private async logTrade(trade: TradeRecord): Promise<void> {
    if (!this.config.logFile) return;
    try {
      await fs.appendFile(this.config.logFile, JSON.stringify(trade) + '\n', 'utf-8');
    } catch {
      // Silently ignore write errors
    }
  }

  // ── Getters ──────────────────────────────────────────────────────────

  getBalance(): Decimal { return this.balance; }
  getPnL(): Decimal { return this.balance.minus(this.startingBalance); }
  getPositions(): Position[] { return Array.from(this.positions.values()); }
  getHistory(): CycleResult[] { return this.history; }
}
