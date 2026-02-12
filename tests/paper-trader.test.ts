import { describe, it, expect, beforeEach, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PaperTrader } from '../src/paper/paper-trader.js';
import { Side, type LegInfo, type CycleResult } from '../src/types/strategy.js';
import type { PaperConfig, TradingConfig } from '../src/config.js';

// ── Test Fixtures ─────────────────────────────────────────────────────

const defaultPaperConfig: PaperConfig = {
  enabled: true,
  startingBalance: 1000,
  simulateFees: true,
  simulateSlippage: false, // off by default — enabled in specific tests
  slippagePct: 0.02,
  logFile: '', // disable file logging in tests
  recordData: false,
  dataDir: 'data',
  recordIntervalMs: 1000,
};

const defaultTradingConfig: TradingConfig = {
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

function makeTrader(
  paperOverrides: Partial<PaperConfig> = {},
  tradingOverrides: Partial<TradingConfig> = {},
): PaperTrader {
  return new PaperTrader(
    { ...defaultPaperConfig, ...paperOverrides },
    { ...defaultTradingConfig, ...tradingOverrides },
  );
}

function makeLeg(overrides: Partial<LegInfo> = {}): LegInfo {
  return {
    side: Side.DOWN,
    price: new Decimal(0.40),
    shares: new Decimal(20),
    tokenId: 'token-down',
    timestamp: new Date(),
    orderType: 'FOK',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('PaperTrader', () => {
  describe('constructor', () => {
    it('should initialize with starting balance', () => {
      const trader = makeTrader();
      expect(trader.getBalance().toNumber()).toBe(1000);
    });

    it('should start with zero P&L', () => {
      const trader = makeTrader();
      expect(trader.getPnL().toNumber()).toBe(0);
    });

    it('should start with no positions', () => {
      const trader = makeTrader();
      expect(trader.getPositions()).toHaveLength(0);
    });

    it('should start with no history', () => {
      const trader = makeTrader();
      expect(trader.getHistory()).toHaveLength(0);
    });
  });

  // ── buy() ─────────────────────────────────────────────────────────

  describe('buy()', () => {
    it('should deduct cost + fee from balance (FOK)', async () => {
      const trader = makeTrader();
      const leg = makeLeg({ price: new Decimal(0.50), shares: new Decimal(10), orderType: 'FOK' });

      const result = await trader.buy(leg, 'round-1');
      expect(result).toBe(true);

      // cost = 0.50 * 10 = 5.00
      // fee = 10 * 0.50 * (1-0.50) * 0.0625 = 10 * 0.015625 = 0.15625
      // total deducted = 5.00 + 0.15625 = 5.15625
      expect(trader.getBalance().toNumber()).toBeCloseTo(1000 - 5.15625, 4);
    });

    it('should deduct cost with zero fee for GTC orders', async () => {
      const trader = makeTrader();
      const leg = makeLeg({ price: new Decimal(0.50), shares: new Decimal(10), orderType: 'GTC' });

      await trader.buy(leg, 'round-1');
      // GTC = maker = no fee → cost = 0.50 * 10 = 5.00
      expect(trader.getBalance().toNumber()).toBeCloseTo(995.00, 4);
    });

    it('should reject buy when insufficient balance', async () => {
      const trader = makeTrader({ startingBalance: 5 });
      // Need: 0.50 * 20 = $10 + fee → way over $5
      const leg = makeLeg({ price: new Decimal(0.50), shares: new Decimal(20) });

      const result = await trader.buy(leg, 'round-1');
      expect(result).toBe(false);
      expect(trader.getBalance().toNumber()).toBe(5); // unchanged
    });

    it('should track position after buy', async () => {
      const trader = makeTrader();
      const leg = makeLeg({ side: Side.UP, tokenId: 'token-up' });

      await trader.buy(leg, 'round-1');
      const positions = trader.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].side).toBe(Side.UP);
      expect(positions[0].tokenId).toBe('token-up');
      expect(positions[0].shares.toNumber()).toBe(20);
    });

    it('should average position on second buy of same side/round', async () => {
      const trader = makeTrader({ simulateFees: false });
      const leg1 = makeLeg({ price: new Decimal(0.40), shares: new Decimal(10) });
      const leg2 = makeLeg({ price: new Decimal(0.50), shares: new Decimal(10) });

      await trader.buy(leg1, 'round-1');
      await trader.buy(leg2, 'round-1');

      const positions = trader.getPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].shares.toNumber()).toBe(20);
      // avgPrice = (0.40*10 + 0.50*10) / 20 = 9/20 = 0.45
      expect(positions[0].avgPrice.toNumber()).toBeCloseTo(0.45, 4);
    });

    it('should track separate positions for different sides', async () => {
      const trader = makeTrader({ simulateFees: false });
      const legUp = makeLeg({ side: Side.UP, tokenId: 'token-up' });
      const legDown = makeLeg({ side: Side.DOWN, tokenId: 'token-down' });

      await trader.buy(legUp, 'round-1');
      await trader.buy(legDown, 'round-1');

      expect(trader.getPositions()).toHaveLength(2);
    });

    it('should track separate positions for different rounds', async () => {
      const trader = makeTrader({ simulateFees: false });
      const leg = makeLeg();

      await trader.buy(leg, 'round-1');
      await trader.buy(leg, 'round-2');

      expect(trader.getPositions()).toHaveLength(2);
    });

    it('should emit trade event on buy', async () => {
      const trader = makeTrader();
      const events: unknown[] = [];
      trader.on('trade', (e) => events.push(e));

      await trader.buy(makeLeg(), 'round-1');
      expect(events).toHaveLength(1);
    });

    it('should emit log event on insufficient balance', async () => {
      const trader = makeTrader({ startingBalance: 1 });
      const logs: unknown[] = [];
      trader.on('log', (e) => logs.push(e));

      await trader.buy(makeLeg(), 'round-1');
      expect(logs).toHaveLength(1);
    });
  });

  // ── buy() fee calculation ─────────────────────────────────────────

  describe('buy() fee calculation', () => {
    it('should not charge fees when simulateFees is false', async () => {
      const trader = makeTrader({ simulateFees: false });
      const leg = makeLeg({ price: new Decimal(0.50), shares: new Decimal(10), orderType: 'FOK' });

      await trader.buy(leg, 'round-1');
      // No fee → cost = 0.50 * 10 = 5.00
      expect(trader.getBalance().toNumber()).toBe(995);
    });

    it('should apply quadratic fee at 50/50 odds', async () => {
      const trader = makeTrader();
      const leg = makeLeg({ price: new Decimal(0.50), shares: new Decimal(100), orderType: 'FOK' });

      await trader.buy(leg, 'round-1');
      // fee = 100 * 0.50 * 0.50 * 0.0625 = 1.5625
      // cost = 50 + 1.5625 = 51.5625
      expect(trader.getBalance().toNumber()).toBeCloseTo(1000 - 51.5625, 4);
    });

    it('should apply higher fee% at lower prices (quadratic property)', async () => {
      // At price=0.20: fee per share = 0.20 * 0.80 * 0.0625 = 0.01
      // fee% of cost = 0.01 / 0.20 = 5.0%
      const trader20 = makeTrader();
      const leg20 = makeLeg({ price: new Decimal(0.20), shares: new Decimal(100), orderType: 'FOK' });
      await trader20.buy(leg20, 'round-1');
      const cost20 = 1000 - trader20.getBalance().toNumber();

      // At price=0.50: fee per share = 0.50 * 0.50 * 0.0625 = 0.015625
      // fee% of cost = 0.015625 / 0.50 = 3.125%
      const trader50 = makeTrader();
      const leg50 = makeLeg({ price: new Decimal(0.50), shares: new Decimal(100), orderType: 'FOK' });
      await trader50.buy(leg50, 'round-1');
      const cost50 = 1000 - trader50.getBalance().toNumber();

      // Fee percentage of cost is higher at 0.20 than at 0.50
      const feePct20 = (cost20 - 20) / 20; // fee / base cost
      const feePct50 = (cost50 - 50) / 50;
      expect(feePct20).toBeGreaterThan(feePct50);
    });

    it('should charge zero fee at price extremes (0 or 1)', async () => {
      // At price=0 or 1: p*(1-p)=0 → fee=0
      const trader = makeTrader();
      // Can't actually buy at 0 (free), so test at near-1
      const leg = makeLeg({ price: new Decimal(1.0), shares: new Decimal(10), orderType: 'FOK' });
      await trader.buy(leg, 'round-1');
      // fee = 10 * 1.0 * 0.0 * 0.0625 = 0
      // cost = 10 + 0 = 10
      expect(trader.getBalance().toNumber()).toBe(990);
    });
  });

  // ── buy() slippage model ──────────────────────────────────────────

  describe('buy() slippage model', () => {
    it('should not apply slippage when simulateSlippage is false', async () => {
      const trader = makeTrader({ simulateSlippage: false, simulateFees: false });
      const leg = makeLeg({
        price: new Decimal(0.40),
        shares: new Decimal(10),
        bestBid: new Decimal(0.39),
        bestAsk: new Decimal(0.42),
        orderType: 'FOK',
      });

      await trader.buy(leg, 'round-1');
      // No slippage, no fee → exact cost = 0.40 * 10 = 4.00
      expect(trader.getBalance().toNumber()).toBe(996);
    });

    it('should apply spread-based slippage for FOK with book data', async () => {
      const trader = makeTrader({ simulateSlippage: true, simulateFees: false });
      const leg = makeLeg({
        price: new Decimal(0.40),
        shares: new Decimal(50), // base slippage at 50 shares
        bestBid: new Decimal(0.39),
        bestAsk: new Decimal(0.42),
        orderType: 'FOK',
      });

      await trader.buy(leg, 'round-1');

      // spreadSlip = bestAsk - price = 0.42 - 0.40 = 0.02
      // sizeSlip = price * slippagePct * (shares/50) = 0.40 * 0.02 * (50/50) = 0.008
      // effectivePrice = 0.40 + 0.02 + 0.008 = 0.428
      // cost = 0.428 * 50 = 21.40
      const balance = trader.getBalance().toNumber();
      expect(balance).toBeCloseTo(1000 - 21.40, 2);
    });

    it('should scale slippage with order size (walking the book)', async () => {
      const traderSmall = makeTrader({ simulateSlippage: true, simulateFees: false });
      const traderLarge = makeTrader({ simulateSlippage: true, simulateFees: false });

      const bookData = {
        price: new Decimal(0.40),
        bestBid: new Decimal(0.39),
        bestAsk: new Decimal(0.42),
        orderType: 'FOK' as const,
      };

      await traderSmall.buy(makeLeg({ ...bookData, shares: new Decimal(10) }), 'round-1');
      await traderLarge.buy(makeLeg({ ...bookData, shares: new Decimal(100) }), 'round-1');

      // Larger order should cost more per share (more slippage)
      const costSmall = (1000 - traderSmall.getBalance().toNumber()) / 10;
      const costLarge = (1000 - traderLarge.getBalance().toNumber()) / 100;
      expect(costLarge).toBeGreaterThan(costSmall);
    });

    it('should cap slippage at ask + 2%', async () => {
      const trader = makeTrader({ simulateSlippage: true, simulateFees: false, slippagePct: 0.50 });
      const leg = makeLeg({
        price: new Decimal(0.40),
        shares: new Decimal(500), // huge order → extreme slippage
        bestBid: new Decimal(0.39),
        bestAsk: new Decimal(0.42),
        orderType: 'FOK',
      });

      await trader.buy(leg, 'round-1');

      // Max effectivePrice = bestAsk * 1.02 = 0.42 * 1.02 = 0.4284
      // cost <= 0.4284 * 500 = 214.20
      const cost = 1000 - trader.getBalance().toNumber();
      expect(cost).toBeLessThanOrEqual(0.4284 * 500 + 0.01); // small float tolerance
    });

    it('should apply zero slippage for GTC orders', async () => {
      const trader = makeTrader({ simulateSlippage: true, simulateFees: false });
      const leg = makeLeg({
        price: new Decimal(0.40),
        shares: new Decimal(50),
        bestBid: new Decimal(0.39),
        bestAsk: new Decimal(0.42),
        orderType: 'GTC',
      });

      await trader.buy(leg, 'round-1');
      // GTC = maker = fills at limit price, zero slippage
      // cost = 0.40 * 50 = 20.00
      expect(trader.getBalance().toNumber()).toBe(980);
    });

    it('should apply static fallback slippage for FOK without book data', async () => {
      const trader = makeTrader({ simulateSlippage: true, simulateFees: false, slippagePct: 0.02 });
      const leg = makeLeg({
        price: new Decimal(0.40),
        shares: new Decimal(10),
        orderType: 'FOK',
        // no bestBid/bestAsk
      });

      await trader.buy(leg, 'round-1');
      // static slip = price * slippagePct = 0.40 * 0.02 = 0.008
      // effectivePrice = 0.40 + 0.008 = 0.408
      // cost = 0.408 * 10 = 4.08
      expect(trader.getBalance().toNumber()).toBeCloseTo(1000 - 4.08, 4);
    });
  });

  // ── sell() ────────────────────────────────────────────────────────

  describe('sell()', () => {
    it('should credit proceeds minus fee to balance', async () => {
      const trader = makeTrader({ simulateFees: true });

      const netProceeds = await trader.sell(
        'token-up', Side.UP, new Decimal(20), new Decimal(0.80), 'round-1',
      );

      // proceeds = 0.80 * 20 = 16.00
      // fee = 20 * 0.80 * 0.20 * 0.0625 = 0.20
      // net = 16.00 - 0.20 = 15.80
      expect(netProceeds.toNumber()).toBeCloseTo(15.80, 4);
      expect(trader.getBalance().toNumber()).toBeCloseTo(1000 + 15.80, 4);
    });

    it('should credit full proceeds when fees disabled', async () => {
      const trader = makeTrader({ simulateFees: false });

      const netProceeds = await trader.sell(
        'token-up', Side.UP, new Decimal(20), new Decimal(0.80), 'round-1',
      );

      expect(netProceeds.toNumber()).toBe(16);
      expect(trader.getBalance().toNumber()).toBe(1016);
    });

    it('should remove position after sell', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ side: Side.UP, tokenId: 'token-up' }), 'round-1');
      expect(trader.getPositions()).toHaveLength(1);

      await trader.sell('token-up', Side.UP, new Decimal(20), new Decimal(0.45), 'round-1');
      expect(trader.getPositions()).toHaveLength(0);
    });

    it('should emit trade event on sell', async () => {
      const trader = makeTrader();
      const events: unknown[] = [];
      trader.on('trade', (e) => events.push(e));

      await trader.sell('token-up', Side.UP, new Decimal(10), new Decimal(0.50), 'round-1');
      expect(events).toHaveLength(1);
    });

    it('should return net proceeds as Decimal', async () => {
      const trader = makeTrader({ simulateFees: false });
      const net = await trader.sell('t', Side.DOWN, new Decimal(50), new Decimal(0.60), 'r1');
      expect(net).toBeInstanceOf(Decimal);
      expect(net.toNumber()).toBe(30);
    });
  });

  // ── settleRound() ────────────────────────────────────────────────

  describe('settleRound()', () => {
    it('should pay $1/share for winning side', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ side: Side.UP, shares: new Decimal(50) }), 'round-1');

      const payout = await trader.settleRound('round-1', Side.UP);
      expect(payout.toNumber()).toBe(50); // $1 * 50 shares
    });

    it('should pay $0 for losing side', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ side: Side.DOWN, shares: new Decimal(50) }), 'round-1');

      const payout = await trader.settleRound('round-1', Side.UP);
      expect(payout.toNumber()).toBe(0);
    });

    it('should pay both sides correctly (hedged position)', async () => {
      const trader = makeTrader({ simulateFees: false });
      // Hedged: buy both sides
      await trader.buy(makeLeg({ side: Side.UP, tokenId: 'up', shares: new Decimal(30) }), 'round-1');
      await trader.buy(makeLeg({ side: Side.DOWN, tokenId: 'down', shares: new Decimal(30) }), 'round-1');

      // UP wins → 30 shares * $1 = $30 payout
      const payout = await trader.settleRound('round-1', Side.UP);
      expect(payout.toNumber()).toBe(30);
    });

    it('should clear all positions for the round', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ side: Side.UP, tokenId: 'up' }), 'round-1');
      await trader.buy(makeLeg({ side: Side.DOWN, tokenId: 'down' }), 'round-1');
      expect(trader.getPositions()).toHaveLength(2);

      await trader.settleRound('round-1', Side.UP);
      expect(trader.getPositions()).toHaveLength(0);
    });

    it('should not affect positions from other rounds', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ side: Side.UP }), 'round-1');
      await trader.buy(makeLeg({ side: Side.UP }), 'round-2');

      await trader.settleRound('round-1', Side.UP);
      expect(trader.getPositions()).toHaveLength(1); // round-2 still there
    });

    it('should emit settled event', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ side: Side.UP }), 'round-1');

      const events: unknown[] = [];
      trader.on('settled', (e) => events.push(e));

      await trader.settleRound('round-1', Side.UP);
      expect(events).toHaveLength(1);
    });
  });

  // ── abandonRound() ────────────────────────────────────────────────

  describe('abandonRound()', () => {
    it('should remove all positions for the round', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ side: Side.UP, tokenId: 'up' }), 'round-1');
      await trader.buy(makeLeg({ side: Side.DOWN, tokenId: 'down' }), 'round-1');

      trader.abandonRound('round-1');
      expect(trader.getPositions()).toHaveLength(0);
    });

    it('should not change balance (positions lost)', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ price: new Decimal(0.40), shares: new Decimal(10) }), 'round-1');
      const balAfterBuy = trader.getBalance().toNumber();

      trader.abandonRound('round-1');
      expect(trader.getBalance().toNumber()).toBe(balAfterBuy); // no change
    });

    it('should not affect other rounds', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg(), 'round-1');
      await trader.buy(makeLeg(), 'round-2');

      trader.abandonRound('round-1');
      expect(trader.getPositions()).toHaveLength(1);
    });

    it('should be safe to call on nonexistent round', () => {
      const trader = makeTrader();
      expect(() => trader.abandonRound('nonexistent')).not.toThrow();
    });
  });

  // ── recordCycle() ─────────────────────────────────────────────────

  describe('recordCycle()', () => {
    it('should add cycle to history', () => {
      const trader = makeTrader();
      const result: CycleResult = {
        roundSlug: 'round-1',
        leg1: makeLeg(),
        leg2: makeLeg({ side: Side.UP }),
        totalCost: new Decimal(18),
        payout: new Decimal(20),
        profit: new Decimal(2),
        profitPct: new Decimal(0.111),
        status: 'completed',
        completedAt: new Date(),
      };

      trader.recordCycle(result);
      expect(trader.getHistory()).toHaveLength(1);
      expect(trader.getHistory()[0].status).toBe('completed');
    });

    it('should accumulate history entries', () => {
      const trader = makeTrader();
      const base: CycleResult = {
        roundSlug: 'round-1',
        leg1: makeLeg(),
        leg2: null,
        totalCost: new Decimal(8),
        payout: new Decimal(0),
        profit: new Decimal(-8),
        profitPct: new Decimal(-1),
        status: 'emergency_exit',
        completedAt: new Date(),
      };

      trader.recordCycle({ ...base, roundSlug: 'round-1' });
      trader.recordCycle({ ...base, roundSlug: 'round-2' });
      trader.recordCycle({ ...base, roundSlug: 'round-3' });
      expect(trader.getHistory()).toHaveLength(3);
    });
  });

  // ── P&L tracking ─────────────────────────────────────────────────

  describe('P&L tracking', () => {
    it('should show negative P&L after buying', async () => {
      const trader = makeTrader({ simulateFees: false });
      await trader.buy(makeLeg({ price: new Decimal(0.40), shares: new Decimal(10) }), 'round-1');
      expect(trader.getPnL().toNumber()).toBe(-4); // spent $4
    });

    it('should show positive P&L after profitable sell', async () => {
      const trader = makeTrader({ simulateFees: false });
      // Buy at 0.40, sell at 0.80
      await trader.buy(makeLeg({ side: Side.UP, price: new Decimal(0.40), shares: new Decimal(10), orderType: 'GTC' }), 'round-1');
      await trader.sell('token-up', Side.UP, new Decimal(10), new Decimal(0.80), 'round-1');
      // -4 + 8 = +4
      expect(trader.getPnL().toNumber()).toBe(4);
    });

    it('should track P&L across multiple rounds', async () => {
      const trader = makeTrader({ simulateFees: false });

      // Round 1: buy at 0.40, settle win → cost 4, payout 10 → +6
      await trader.buy(makeLeg({ side: Side.UP, price: new Decimal(0.40), shares: new Decimal(10) }), 'round-1');
      await trader.settleRound('round-1', Side.UP);

      // Round 2: buy at 0.50, abandon → cost 5, payout 0 → -5
      await trader.buy(makeLeg({ side: Side.DOWN, price: new Decimal(0.50), shares: new Decimal(10) }), 'round-2');
      trader.abandonRound('round-2');

      // Net: +6 - 5 = +1
      expect(trader.getPnL().toNumber()).toBe(1);
    });

    it('should show correct P&L with fees', async () => {
      const trader = makeTrader({ simulateFees: true });
      // Buy 10 shares at $0.50 FOK
      // cost = 5.00, fee = 10 * 0.50 * 0.50 * 0.0625 = 0.15625
      await trader.buy(
        makeLeg({ side: Side.UP, price: new Decimal(0.50), shares: new Decimal(10), orderType: 'FOK' }),
        'round-1',
      );

      // Settle win: +10
      await trader.settleRound('round-1', Side.UP);

      // P&L = -5.15625 + 10 = 4.84375
      expect(trader.getPnL().toNumber()).toBeCloseTo(4.84375, 4);
    });
  });

  // ── Full cycle simulation ─────────────────────────────────────────

  describe('full cycle simulation', () => {
    it('should simulate profitable hedged cycle', async () => {
      const trader = makeTrader({ simulateFees: false });

      // Buy DOWN at 0.42 (50 shares) → cost $21
      await trader.buy(
        makeLeg({ side: Side.DOWN, tokenId: 'down', price: new Decimal(0.42), shares: new Decimal(50) }),
        'round-1',
      );
      // Buy UP at 0.49 (50 shares) → cost $24.50
      await trader.buy(
        makeLeg({ side: Side.UP, tokenId: 'up', price: new Decimal(0.49), shares: new Decimal(50) }),
        'round-1',
      );
      // Total cost = $45.50

      // UP wins → $50 payout
      const payout = await trader.settleRound('round-1', Side.UP);
      expect(payout.toNumber()).toBe(50);

      // Profit = 1000 - 45.50 + 50 = $4.50
      expect(trader.getPnL().toNumber()).toBe(4.5);
    });

    it('should simulate unprofitable hedged cycle (sum > 1.00)', async () => {
      const trader = makeTrader({ simulateFees: false });

      // Buy DOWN at 0.55 (20 shares) → cost $11
      await trader.buy(
        makeLeg({ side: Side.DOWN, tokenId: 'down', price: new Decimal(0.55), shares: new Decimal(20) }),
        'round-1',
      );
      // Buy UP at 0.52 (20 shares) → cost $10.40
      await trader.buy(
        makeLeg({ side: Side.UP, tokenId: 'up', price: new Decimal(0.52), shares: new Decimal(20) }),
        'round-1',
      );
      // Total cost = $21.40, sum = 1.07 > $1 → loss guaranteed

      const payout = await trader.settleRound('round-1', Side.DOWN);
      expect(payout.toNumber()).toBe(20); // $1 * 20 winning shares

      // P&L = -21.40 + 20 = -1.40
      expect(trader.getPnL().toNumber()).toBeCloseTo(-1.40, 4);
    });

    it('should simulate emergency exit with sell', async () => {
      const trader = makeTrader({ simulateFees: false });

      // Buy DOWN at 0.40, 20 shares → cost $8
      await trader.buy(
        makeLeg({ side: Side.DOWN, tokenId: 'down', price: new Decimal(0.40), shares: new Decimal(20) }),
        'round-1',
      );

      // Emergency: sell at 0.30 (price dropped)
      const net = await trader.sell('down', Side.DOWN, new Decimal(20), new Decimal(0.30), 'round-1');
      expect(net.toNumber()).toBe(6); // 0.30 * 20 = 6

      // P&L = -8 + 6 = -2
      expect(trader.getPnL().toNumber()).toBe(-2);
      expect(trader.getPositions()).toHaveLength(0);
    });

    it('should simulate early liquidation with sell near expiry', async () => {
      const trader = makeTrader({ simulateFees: false });

      // Buy UP at 0.42 (50 shares) + DOWN at 0.49 (50 shares) = $45.50 cost
      await trader.buy(
        makeLeg({ side: Side.UP, tokenId: 'up', price: new Decimal(0.42), shares: new Decimal(50) }),
        'round-1',
      );
      await trader.buy(
        makeLeg({ side: Side.DOWN, tokenId: 'down', price: new Decimal(0.49), shares: new Decimal(50) }),
        'round-1',
      );

      // Near expiry, UP is winning → UP price ~$0.95, DOWN price ~$0.05
      // Sell UP at 0.95 (winning side)
      const netUp = await trader.sell('up', Side.UP, new Decimal(50), new Decimal(0.95), 'round-1');
      expect(netUp.toNumber()).toBe(47.5); // 0.95 * 50

      // Sell DOWN at 0.05 (losing side)
      const netDown = await trader.sell('down', Side.DOWN, new Decimal(50), new Decimal(0.05), 'round-1');
      expect(netDown.toNumber()).toBe(2.5); // 0.05 * 50

      // Total received = 47.5 + 2.5 = 50 → P&L = -45.50 + 50 = +4.50
      expect(trader.getPnL().toNumber()).toBe(4.5);
    });
  });
});
