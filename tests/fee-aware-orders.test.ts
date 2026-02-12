import { describe, it, expect } from 'vitest';
import { FeeAwareOrderPlacer } from '../src/strategy/fee-aware-orders.js';
import type { TradingConfig } from '../src/config.js';

const defaultConfig: TradingConfig = {
  assets: ['BTC'],
  duration: '15m',
  defaultShares: 20,
  defaultSumTarget: 0.92,
  defaultDipThreshold: 0.15,
  windowMinutes: 2,
  maxCycles: 1,
  dumpWindowMs: 3000,
  useMakerOrders: true,
  makerFallbackToTaker: true,
  takerFeeRate: 0.0625,
  maxSpreadPct: 0.10,
  liquidateBeforeExpirySecs: 15,
  gtcFillTimeoutMs: 30000,
  gtcPollIntervalMs: 1000,
};

function makePlacer(overrides: Partial<TradingConfig> = {}): FeeAwareOrderPlacer {
  return new FeeAwareOrderPlacer({ ...defaultConfig, ...overrides });
}

describe('FeeAwareOrderPlacer', () => {
  describe('decideLeg1OrderType', () => {
    it('should use GTC when profit margin is tight', () => {
      const placer = makePlacer();
      // sum = 0.45 + 0.50 = 0.95, margin from 0.92 target = negative → GTC
      const result = placer.decideLeg1OrderType(0.45, 0.50, 0.92);
      expect(result).toBe('GTC');
    });

    it('should use FOK when profit margin greatly exceeds fee', () => {
      const placer = makePlacer();
      // sum = 0.30 + 0.40 = 0.70, margin = (0.92 - 0.70) / 0.92 = 0.239 >> fee
      const result = placer.decideLeg1OrderType(0.30, 0.40, 0.92);
      expect(result).toBe('FOK');
    });

    it('should always use FOK when useMakerOrders is false', () => {
      const placer = makePlacer({ useMakerOrders: false });
      const result = placer.decideLeg1OrderType(0.45, 0.50, 0.92);
      expect(result).toBe('FOK');
    });
  });

  describe('decideLeg2OrderType', () => {
    it('should always return GTC', () => {
      const placer = makePlacer();
      expect(placer.decideLeg2OrderType()).toBe('GTC');
    });
  });

  describe('estimateTakerFee', () => {
    it('should return ~3.125% at 50/50 odds', () => {
      const placer = makePlacer();
      // (1 - 0.50) * 0.0625 = 0.03125
      const fee = placer.estimateTakerFee(0.50);
      expect(fee).toBeCloseTo(0.03125, 5);
    });

    it('should return higher fee % at lower prices (quadratic)', () => {
      const placer = makePlacer();
      // (1-0.20)*0.0625 = 0.05 (5.0%)
      // (1-0.50)*0.0625 = 0.03125 (3.125%)
      // Fee as % of cost is HIGHER at lower prices
      const fee20 = placer.estimateTakerFee(0.20);
      const fee50 = placer.estimateTakerFee(0.50);
      expect(fee20).toBeGreaterThan(fee50);
      expect(fee20).toBeCloseTo(0.05, 5);
    });

    it('should return correct fee at typical leg1 price (0.40)', () => {
      const placer = makePlacer();
      // (1-0.40)*0.0625 = 0.0375 (3.75%)
      const fee = placer.estimateTakerFee(0.40);
      expect(fee).toBeCloseTo(0.0375, 5);
    });

    it('should return 0 at price extremes (0 or 1)', () => {
      const placer = makePlacer();
      expect(placer.estimateTakerFee(0.0)).toBe(0);
      expect(placer.estimateTakerFee(1.0)).toBe(0);
    });
  });

  describe('calculateLimitPrice', () => {
    it('should place buy price just above best bid', () => {
      const placer = makePlacer();
      const price = placer.calculateLimitPrice(0.40, 0.45, 'buy');
      expect(price).toBeCloseTo(0.41, 10); // bid + 0.01
    });

    it('should place sell price just below best ask', () => {
      const placer = makePlacer();
      const price = placer.calculateLimitPrice(0.40, 0.45, 'sell');
      expect(price).toBeCloseTo(0.44, 10); // ask - 0.01
    });

    it('should not cross the ask when buying', () => {
      const placer = makePlacer();
      // Tight spread: bid=0.44, ask=0.45
      const price = placer.calculateLimitPrice(0.44, 0.45, 'buy');
      expect(price).toBeLessThan(0.45); // Must stay below ask
    });

    it('should not cross the bid when selling', () => {
      const placer = makePlacer();
      // Tight spread: bid=0.44, ask=0.45
      const price = placer.calculateLimitPrice(0.44, 0.45, 'sell');
      expect(price).toBeGreaterThan(0.44); // Must stay above bid
    });
  });

  describe('effectiveCost', () => {
    it('should return base cost for GTC (maker)', () => {
      const placer = makePlacer();
      const cost = placer.effectiveCost(0.50, 10, 'GTC');
      expect(cost).toBe(5.0); // 0.50 * 10, no fee
    });

    it('should add fee for FOK (taker)', () => {
      const placer = makePlacer();
      const cost = placer.effectiveCost(0.50, 10, 'FOK');
      // fee_rate = (1-0.50)*0.0625 = 0.03125
      // cost = 5.0 * (1 + 0.03125) = 5.15625
      expect(cost).toBeGreaterThan(5.0);
      expect(cost).toBeCloseTo(5.15625, 4);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe('decideLeg1OrderType edge cases', () => {
    it('should use GTC when margin equals fee exactly (border case)', () => {
      const placer = makePlacer();
      // At price=0.40: fee = (1-0.40)*0.0625 = 0.0375
      // We need margin ≈ fee*1.5 = 0.05625 for FOK
      // margin = (target - sum) / target, so sum = target * (1 - margin)
      // sum for margin=0.0375: 0.92 * (1-0.0375) = 0.8855 → GTC (margin not > fee*1.5)
      const result = placer.decideLeg1OrderType(0.40, 0.4855, 0.92);
      expect(result).toBe('GTC');
    });

    it('should use GTC even with makerFallbackToTaker=false and big margin', () => {
      const placer = makePlacer({ makerFallbackToTaker: false });
      // Huge margin but fallback disabled → always GTC
      const result = placer.decideLeg1OrderType(0.20, 0.20, 0.92);
      expect(result).toBe('GTC');
    });

    it('should use GTC when sum exceeds target (negative margin)', () => {
      const placer = makePlacer();
      // sum = 0.50 + 0.50 = 1.00 > 0.92 target → negative margin → GTC
      const result = placer.decideLeg1OrderType(0.50, 0.50, 0.92);
      expect(result).toBe('GTC');
    });
  });

  describe('calculateLimitPrice edge cases', () => {
    it('should handle 1-tick spread (bid=0.49, ask=0.50)', () => {
      const placer = makePlacer();
      // Buy: bid + 0.01 = 0.50, but min(0.50, ask-0.01=0.49) → 0.49
      const buyPrice = placer.calculateLimitPrice(0.49, 0.50, 'buy');
      expect(buyPrice).toBeCloseTo(0.49, 10);

      // Sell: ask - 0.01 = 0.49, but max(0.49, bid+0.01=0.50) → 0.50
      const sellPrice = placer.calculateLimitPrice(0.49, 0.50, 'sell');
      expect(sellPrice).toBeCloseTo(0.50, 10);
    });

    it('should handle wide spread', () => {
      const placer = makePlacer();
      // bid=0.30, ask=0.70 → buy at 0.31, sell at 0.69
      expect(placer.calculateLimitPrice(0.30, 0.70, 'buy')).toBeCloseTo(0.31, 10);
      expect(placer.calculateLimitPrice(0.30, 0.70, 'sell')).toBeCloseTo(0.69, 10);
    });

    it('should handle prices at extremes', () => {
      const placer = makePlacer();
      // bid=0.01, ask=0.02
      const price = placer.calculateLimitPrice(0.01, 0.02, 'buy');
      expect(price).toBeCloseTo(0.01, 10); // min(0.02, 0.01) = 0.01
    });
  });

  describe('effectiveCost edge cases', () => {
    it('should scale linearly with share count', () => {
      const placer = makePlacer();
      const cost1 = placer.effectiveCost(0.40, 1, 'FOK');
      const cost100 = placer.effectiveCost(0.40, 100, 'FOK');
      expect(cost100).toBeCloseTo(cost1 * 100, 4);
    });

    it('should have zero fee at price $1 (FOK)', () => {
      const placer = makePlacer();
      // At p=1.0: fee_rate = (1-1)*0.0625 = 0
      const cost = placer.effectiveCost(1.0, 10, 'FOK');
      expect(cost).toBe(10.0); // no fee
    });

    it('should match GTC and FOK cost at price extremes', () => {
      const placer = makePlacer();
      // At p=0 or p=1, taker fee=0, so GTC and FOK costs match
      expect(placer.effectiveCost(1.0, 10, 'FOK')).toBe(placer.effectiveCost(1.0, 10, 'GTC'));
    });
  });
});
