import type { RiskConfig } from '../config.js';

export type { RiskConfig };

/**
 * Position Sizer — controls how much capital to risk per cycle.
 *
 * Rules:
 * 1. Max % of balance per trade (default 5%)
 * 2. Min shares floor (Polymarket minimum: 5 shares)
 * 3. Max shares cap (absolute upper bound)
 * 4. Consecutive loss cooldown — pause after N losses in a row
 *
 * The key insight: a full cycle risks leg1_cost if the hedge never comes.
 * So "risk per trade" = leg1_price * shares (worst case = total loss of Leg 1).
 * A completed cycle risks much less (sum - 1.00 is the profit, not loss).
 */

export class PositionSizer {
  private config: RiskConfig;

  // Session tracking
  private consecutiveLosses = 0;
  private cooldownUntil: number | null = null; // ms timestamp

  constructor(config: RiskConfig, _startingBalance?: number) {
    this.config = config;
  }

  /**
   * Calculate how many shares to buy for Leg 1.
   *
   * Logic:
   *   maxRisk = balance * maxBalancePctPerTrade
   *   shares  = floor(maxRisk / leg1Price)
   *   shares  = clamp(shares, minShares, maxShares)
   *
   * Returns 0 if trading should be paused (circuit breaker).
   */
  calculateShares(currentBalance: number, leg1Price: number): number {
    // ── Circuit breakers ────────────────────────────────────────────
    if (this.isTradingPaused()) return 0;

    // ── Position sizing ─────────────────────────────────────────────
    // Worst case: Leg 1 is a total loss (no hedge, expired worthless)
    // So risk = leg1Price * shares
    const maxRisk = currentBalance * this.config.maxBalancePctPerTrade;
    let shares = Math.floor(maxRisk / leg1Price);

    // Cap at maximum
    shares = Math.min(shares, this.config.maxShares);

    // 95% absolute safety rail — never use more than 95% of balance
    if (shares * leg1Price > currentBalance * 0.95) {
      shares = Math.floor((currentBalance * 0.95) / leg1Price);
    }

    // Below minimum? Can't trade. (go/no-go gate, not a clamp-up)
    if (shares < this.config.minShares) return 0;

    return shares;
  }

  /**
   * Check if trading is currently paused by any circuit breaker.
   */
  isTradingPaused(): boolean {
    // Check consecutive loss cooldown
    if (this.cooldownUntil !== null && Date.now() < this.cooldownUntil) return true;

    // Cooldown expired? Reset it
    if (this.cooldownUntil !== null && Date.now() >= this.cooldownUntil) {
      this.cooldownUntil = null;
      this.consecutiveLosses = 0;
    }

    return false;
  }

  /**
   * Get reason for pause (for logging/TUI display).
   */
  getPauseReason(): string | null {
    if (this.cooldownUntil !== null && Date.now() < this.cooldownUntil) {
      const remaining = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
      return `Cooldown: ${this.consecutiveLosses} consecutive losses, ${remaining}min remaining`;
    }
    return null;
  }

  /**
   * Record a cycle result. Updates daily P&L and consecutive loss tracking.
   */
  recordResult(profit: number): void {
    if (profit < 0) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.config.consecutiveLossLimit) {
        this.cooldownUntil = Date.now() + this.config.cooldownMinutes * 60 * 1000;
      }
    } else {
      this.consecutiveLosses = 0; // Reset on any win
    }
  }

  /**
   * Reset daily tracking (call at start of new session/day).
   */
  resetConsecutiveLosses(): void {
    this.consecutiveLosses = 0;
    this.cooldownUntil = null;
  }

  // ── Getters for TUI display ────────────────────────────────────────

  getConsecutiveLosses(): number { return this.consecutiveLosses; }
  getCooldownUntil(): number | null { return this.cooldownUntil; }
}
