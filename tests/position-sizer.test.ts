import { describe, it, expect, beforeEach } from 'vitest';
import { PositionSizer, type RiskConfig } from '../src/strategy/position-sizer.js';

const defaultConfig: RiskConfig = {
  maxBalancePctPerTrade: 0.05,   // 5% of balance
  minShares: 5,
  maxShares: 100,
  consecutiveLossLimit: 3,
  cooldownMinutes: 360,          // 6 hours
  emergencyEnabled: true,
  exitBeforeExpiryMinutes: 3,
};

describe('PositionSizer', () => {
  describe('calculateShares', () => {
    it('should size based on % of balance', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      // balance=1000, 5% = $50 risk, price=0.40 → 50/0.40 = 125 → capped at 100
      const shares = sizer.calculateShares(1000, 0.40);
      expect(shares).toBe(100); // hits maxShares cap
    });

    it('should scale down with smaller balance', () => {
      const sizer = new PositionSizer(defaultConfig, 200);
      // balance=200, 5% = $10 risk, price=0.40 → 10/0.40 = 25
      const shares = sizer.calculateShares(200, 0.40);
      expect(shares).toBe(25);
    });

    it('should scale down with higher price', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      // balance=1000, 5% = $50 risk, price=0.60 → 50/0.60 = 83
      const shares = sizer.calculateShares(1000, 0.60);
      expect(shares).toBe(83);
    });

    it('should return 0 when budget is below minShares (no clamp-up)', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      // balance=10, 5% = $0.50 risk, $0.50/0.40 = 1.25 → floor to 1
      // 1 < minShares(5) → return 0 (don't force up to 5)
      const shares = sizer.calculateShares(10, 0.40);
      expect(shares).toBe(0);
    });

    it('should return minShares when budget exactly affords it', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      // Need floor(maxRisk / price) >= 5
      // maxRisk = balance * 0.05, so need balance * 0.05 / price >= 5
      // At price=0.40: balance >= 5 * 0.40 / 0.05 = 40
      const shares = sizer.calculateShares(40, 0.40);
      // maxRisk = 40 * 0.05 = 2.0, shares = floor(2.0/0.40) = 5
      // 5 >= minShares(5), 5*0.40=2.0 <= 40*0.95=38 → passes safety rail
      expect(shares).toBe(5);
    });

    it('should return 0 if cannot afford minShares', () => {
      const sizer = new PositionSizer(defaultConfig, 1);
      // balance=1, 5% = $0.05, $0.05/0.40 = 0.125 → floor to 0
      // 0 < minShares(5) → return 0
      const shares = sizer.calculateShares(1, 0.40);
      expect(shares).toBe(0);
    });

    it('should cap at maxShares', () => {
      const sizer = new PositionSizer(defaultConfig, 100000);
      // Huge balance, but capped at 100
      const shares = sizer.calculateShares(100000, 0.10);
      expect(shares).toBe(100);
    });

    it('should not use more than 95% of balance', () => {
      const config: RiskConfig = { ...defaultConfig, maxBalancePctPerTrade: 0.99 };
      const sizer = new PositionSizer(config, 100);
      // 99% of $100 = $99, but capped at 95% → $95 / $0.50 = 190 → cap at 100
      const shares = sizer.calculateShares(100, 0.50);
      expect(shares).toBeLessThanOrEqual(100);
      // At $0.50, 95% of $100 = $95 → 190 shares → capped at 100
      expect(shares).toBe(100);
    });
  });

  describe('consecutive loss circuit breaker', () => {
    it('should pause after N consecutive losses', () => {
      const sizer = new PositionSizer(defaultConfig, 10000);
      expect(sizer.isTradingPaused()).toBe(false);

      sizer.recordResult(-5); // loss 1
      sizer.recordResult(-5); // loss 2
      expect(sizer.isTradingPaused()).toBe(false);

      sizer.recordResult(-5); // loss 3 → triggers cooldown
      expect(sizer.isTradingPaused()).toBe(true);
      expect(sizer.getPauseReason()).toContain('consecutive losses');
    });

    it('should reset consecutive count on a win', () => {
      const sizer = new PositionSizer(defaultConfig, 10000);

      sizer.recordResult(-5); // loss 1
      sizer.recordResult(-5); // loss 2
      sizer.recordResult(10);  // win → reset
      sizer.recordResult(-5); // loss 1 (restarted)
      sizer.recordResult(-5); // loss 2
      expect(sizer.isTradingPaused()).toBe(false); // only 2 consecutive, need 3
    });

    it('should return 0 shares when paused', () => {
      const sizer = new PositionSizer(defaultConfig, 10000);
      sizer.recordResult(-5);
      sizer.recordResult(-5);
      sizer.recordResult(-5); // 3 consecutive → cooldown

      const shares = sizer.calculateShares(9985, 0.40);
      expect(shares).toBe(0);
    });

    it('should show cooldown remaining time in pause reason', () => {
      const sizer = new PositionSizer(defaultConfig, 10000);
      sizer.recordResult(-5);
      sizer.recordResult(-5);
      sizer.recordResult(-5); // triggers 6-hour cooldown

      const reason = sizer.getPauseReason();
      expect(reason).toContain('360min remaining');
    });
  });

  describe('resetConsecutiveLosses', () => {
    it('should clear cooldown and consecutive count', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      sizer.recordResult(-5);
      sizer.recordResult(-5);
      sizer.recordResult(-5); // triggers cooldown
      expect(sizer.isTradingPaused()).toBe(true);

      sizer.resetConsecutiveLosses();
      expect(sizer.isTradingPaused()).toBe(false);
      expect(sizer.getConsecutiveLosses()).toBe(0);
    });
  });

  describe('real scenario: $1000 account trading at $0.40', () => {
    it('should size appropriately through a session', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);

      // Trade 1: $1000 balance, price $0.40
      // 5% of $1000 = $50, $50/$0.40 = 125 → capped at 100
      expect(sizer.calculateShares(1000, 0.40)).toBe(100);

      // Win $5
      sizer.recordResult(5);

      // Trade 2: $1005 balance
      expect(sizer.calculateShares(1005, 0.40)).toBe(100); // still capped

      // Lose $40 (emergency exit) — 1 consecutive loss
      sizer.recordResult(-40);

      // Trade 3: $965 balance
      expect(sizer.calculateShares(965, 0.40)).toBe(100);

      // Lose $40 again — 2 consecutive losses
      sizer.recordResult(-40);

      // Trade 4: $925 balance, 2 consecutive losses
      expect(sizer.isTradingPaused()).toBe(false);
      expect(sizer.calculateShares(925, 0.40)).toBe(100);

      // Lose $40 more → 3 consecutive → cooldown triggered
      sizer.recordResult(-40);
      expect(sizer.isTradingPaused()).toBe(true);
      expect(sizer.getConsecutiveLosses()).toBe(3);
      expect(sizer.calculateShares(885, 0.40)).toBe(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle very high price (near $1)', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      // 5% of $1000 = $50, $50/0.95 = 52.6 → floor to 52
      const shares = sizer.calculateShares(1000, 0.95);
      expect(shares).toBe(52);
    });

    it('should handle very low price (near $0)', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      // 5% of $1000 = $50, $50/0.05 = 1000 → capped at 100
      const shares = sizer.calculateShares(1000, 0.05);
      expect(shares).toBe(100);
    });

    it('should return 0 for zero balance', () => {
      const sizer = new PositionSizer(defaultConfig, 1000);
      const shares = sizer.calculateShares(0, 0.40);
      expect(shares).toBe(0);
    });

    it('should apply 95% safety rail before minShares check', () => {
      // Scenario: risk budget says N shares, but N * price > 95% of balance
      // After safety rail, if shares < minShares → return 0
      const config: RiskConfig = { ...defaultConfig, maxBalancePctPerTrade: 0.99, minShares: 10 };
      const sizer = new PositionSizer(config, 5);
      // 99% of $5 = $4.95, price=0.40 → $4.95/0.40 = 12.3 → floor 12
      // 95% rail: 12*0.40=4.80 > 5*0.95=4.75 → 4.75/0.40=11.8 → floor 11
      // 11 >= minShares(10) → 11
      expect(sizer.calculateShares(5, 0.40)).toBe(11);
    });

    it('should return 0 when 95% rail pushes below minShares', () => {
      const config: RiskConfig = { ...defaultConfig, maxBalancePctPerTrade: 0.50, minShares: 20 };
      const sizer = new PositionSizer(config, 10);
      // 50% of $10 = $5, $5/0.40 = 12.5 → floor 12
      // 95% rail: 12*0.40=4.80 <= 10*0.95=9.50 → passes
      // 12 < minShares(20) → return 0
      expect(sizer.calculateShares(10, 0.40)).toBe(0);
    });

    it('should handle break-even result without resetting consecutive losses', () => {
      const sizer = new PositionSizer(defaultConfig, 10000);
      sizer.recordResult(-5); // loss 1
      sizer.recordResult(-5); // loss 2
      sizer.recordResult(0);  // break-even → NOT a loss, resets consecutive
      expect(sizer.getConsecutiveLosses()).toBe(0);
    });
  });
});
