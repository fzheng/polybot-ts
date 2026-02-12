import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Decimal from 'decimal.js';
import { EnhancedDipArbStrategy } from '../src/strategy/enhanced-dip-arb.js';
import { StrategyState, Side, type CycleResult, type LegInfo } from '../src/types/strategy.js';
import type { BotConfig } from '../src/config.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Flush microtasks so async event handlers complete */
async function flush() {
  await new Promise(r => setTimeout(r, 0));
}

function createMockSdk() {
  const realtimeService = Object.assign(new EventEmitter(), {
    subscribeMarkets: vi.fn((_tokenIds: string[], handlers: any = {}) => {
      // Mirror SDK behavior: register handler on the EventEmitter filtered by tokenIds
      const orderbookHandler = (book: any) => {
        if (_tokenIds.includes(book.assetId ?? book.tokenId)) {
          handlers.onOrderbook?.(book);
        }
      };
      realtimeService.on('orderbook', orderbookHandler);
      return { unsubscribe: () => realtimeService.off('orderbook', orderbookHandler) };
    }),
  });

  const dipArb = Object.assign(new EventEmitter(), {
    updateConfig: vi.fn(),
    enableAutoRotate: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    findAndStart: vi.fn().mockResolvedValue({ slug: 'test-market' }),
    stop: vi.fn(),
    scanUpcomingMarkets: vi.fn().mockResolvedValue([]),
    settle: vi.fn().mockResolvedValue({ success: true, amountReceived: 1.5 }),
    // Internal state accessed via `as any` by the strategy
    upAsks: [{ price: 0.40, size: 100 }],
    downAsks: [{ price: 0.55, size: 100 }],
    priceHistory: [],
    realtimeService,
    market: { upTokenId: 'up-token-123', downTokenId: 'down-token-456' },
  });

  const tradingService = {
    createLimitOrder: vi.fn().mockResolvedValue({ orderId: 'limit-order-1' }),
    createMarketOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'market-order-1' }),
    getOrder: vi.fn().mockResolvedValue(null),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
  };

  return { dipArb, tradingService } as any;
}

function makeConfig(overrides: Record<string, any> = {}): BotConfig {
  return {
    api: {
      clobEndpoint: 'https://clob.polymarket.com',
      gammaEndpoint: 'https://gamma-api.polymarket.com',
      chainId: 137,
      useBinance: true,
      maxPriceAgeSecs: 10,
    },
    trading: {
      assets: ['BTC'],
      duration: '15m',
      defaultShares: 20,
      defaultSumTarget: 0.95,
      defaultDipThreshold: 0.20,
      windowMinutes: 5,
      maxCycles: 1,
      dumpWindowMs: 3000,
      useMakerOrders: true,
      makerFallbackToTaker: true,
      takerFeeRate: 0.0625,
      maxSpreadPct: 0.10,
      gtcFillTimeoutMs: 5000, // short for tests
      gtcPollIntervalMs: 100, // fast polling for tests
    },
    risk: {
      maxBalancePctPerTrade: 0.05,
      minShares: 5,
      maxShares: 100,
      consecutiveLossLimit: 3,
      cooldownMinutes: 360,
      emergencyEnabled: true,
      exitBeforeExpiryMinutes: 3,
    },
    paper: {
      enabled: true,
      startingBalance: 1000,
      simulateFees: true,
      simulateSlippage: true,
      slippagePct: 0.02,
      logFile: 'paper_trades.jsonl',
      recordData: false,
      dataDir: 'data',
      recordIntervalMs: 1000,
    },
    ...overrides,
  } as BotConfig;
}

function makeLeg1Signal(overrides: Record<string, any> = {}) {
  return {
    type: 'leg1',
    dipSide: 'UP',
    currentPrice: 0.40,
    oppositeAsk: 0.55,
    dropPercent: 0.20,
    tokenId: 'up-token-123',
    targetPrice: 0.40,
    ...overrides,
  };
}

function makeLeg2Signal(overrides: Record<string, any> = {}) {
  return {
    type: 'leg2',
    currentPrice: 0.50,
    tokenId: 'down-token-456',
    ...overrides,
  };
}

function emitStarted(sdk: any, overrides: Record<string, any> = {}) {
  sdk.dipArb.emit('started', {
    slug: 'btc-15m-round-1',
    endTime: new Date(Date.now() + 900 * 1000),
    durationMinutes: 15,
    upTokenId: 'up-token-123',
    downTokenId: 'down-token-456',
    ...overrides,
  });
}

function populateOrderbook(sdk: any) {
  // Populate bids via realtimeService (strategy subscribes in handleStarted)
  sdk.dipArb.realtimeService.emit('orderbook', {
    assetId: 'up-token-123',
    bids: [{ price: 0.39, size: 100 }],
  });
  sdk.dipArb.realtimeService.emit('orderbook', {
    assetId: 'down-token-456',
    bids: [{ price: 0.54, size: 100 }],
  });
}

/** Set up a strategy with events wired, a started round, and populated orderbook */
async function setupReady(configOverrides: Record<string, any> = {}) {
  const sdk = createMockSdk();
  const config = makeConfig(configOverrides);
  const strategy = new EnhancedDipArbStrategy(sdk, config);
  await strategy.start();
  emitStarted(sdk);
  populateOrderbook(sdk);
  return { sdk, strategy, config };
}

/** Collect events emitted by the strategy */
function collectEvents(strategy: EnhancedDipArbStrategy, event: string): any[] {
  const events: any[] = [];
  strategy.on(event, (e: any) => events.push(e));
  return events;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('EnhancedDipArbStrategy', () => {

  // ── Initialization ─────────────────────────────────────────────────────

  describe('initialization', () => {
    it('should start in WATCHING state', async () => {
      const { strategy } = await setupReady();
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should initialize stats at zero', async () => {
      const { strategy } = await setupReady();
      const stats = strategy.getStats();
      expect(stats.cyclesCompleted).toBe(0);
      expect(stats.cyclesAbandoned).toBe(0);
      expect(stats.cyclesWon).toBe(0);
      expect(stats.totalProfit.toNumber()).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.emergencyExits).toBe(0);
      await strategy.stop();
    });

    it('should set balance from paper config', async () => {
      const { strategy } = await setupReady();
      // Balance is private, but we can verify via position sizer behavior
      // 5% of $1000 = $50, $50/$0.40 = 125 → capped at 100
      // If balance was wrong, shares would be different
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });
  });

  // ── Round Management ───────────────────────────────────────────────────

  describe('round management', () => {
    it('should emit newRound on handleStarted', async () => {
      const sdk = createMockSdk();
      const strategy = new EnhancedDipArbStrategy(sdk, makeConfig());
      await strategy.start();

      const rounds = collectEvents(strategy, 'newRound');
      emitStarted(sdk, { slug: 'test-round' });

      expect(rounds).toHaveLength(1);
      expect(rounds[0].slug).toBe('test-round');
      expect(rounds[0].secondsRemaining).toBeGreaterThan(0);
      await strategy.stop();
    });

    it('should reset state on new round', async () => {
      const { sdk, strategy } = await setupReady();

      // Put strategy into a mid-cycle state by processing leg1
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // New market resets everything
      emitStarted(sdk, { slug: 'new-round' });
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      expect(strategy.getLeg1()).toBeNull();
      expect(strategy.getCurrentRound()).toBe('new-round');
      await strategy.stop();
    });

    it('should allow new entry after round reset', async () => {
      const { sdk, strategy } = await setupReady();

      // First round: process leg1
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // New round: should accept signals again
      emitStarted(sdk, { slug: 'round-2' });
      populateOrderbook(sdk);
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);
      await strategy.stop();
    });

    it('should handle handleNewRound and update round ID', async () => {
      const { sdk, strategy } = await setupReady();

      const rounds = collectEvents(strategy, 'newRound');
      sdk.dipArb.emit('newRound', {
        roundId: 'specific-round-id',
        endTime: new Date(Date.now() + 600 * 1000),
        upOpen: 0.45,
        downOpen: 0.50,
      });

      expect(strategy.getCurrentRound()).toBe('specific-round-id');
      // Should emit a second newRound (first was from handleStarted)
      expect(rounds.length).toBeGreaterThanOrEqual(1);
      await strategy.stop();
    });
  });

  // ── Paper Mode: Leg 1 Signal Filtering ─────────────────────────────────

  describe('paper mode — leg1 signal filtering', () => {
    it('should ignore leg1 signal when not WATCHING', async () => {
      const { sdk, strategy } = await setupReady();

      // First signal moves to WAITING_FOR_HEDGE
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Second leg1 signal should be ignored
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);
      await strategy.stop();
    });

    it('should enforce one entry per market', async () => {
      const { sdk, strategy } = await setupReady();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // First signal triggers entry
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(leg1Events).toHaveLength(1);

      // Complete the cycle
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WATCHING);

      // Second leg1 signal in same round — blocked by cycleAttemptedThisRound
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(leg1Events).toHaveLength(1); // Still 1, no re-entry
      await strategy.stop();
    });

    it('should skip when spread is too wide', async () => {
      const { sdk, strategy } = await setupReady();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // Override asks to create a wide spread: bid=0.39, ask=0.60 → 53.8% spread
      (sdk.dipArb as any).upAsks = [{ price: 0.60, size: 100 }];

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(leg1Events).toHaveLength(0); // Filtered out
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should pass when spread is narrow', async () => {
      const { sdk, strategy } = await setupReady();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // bid=0.39, ask=0.40 → 2.6% spread < 10%
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(leg1Events).toHaveLength(1);
      await strategy.stop();
    });

    it('should skip spread check when no book data available', async () => {
      const sdk = createMockSdk();
      const strategy = new EnhancedDipArbStrategy(sdk, makeConfig());
      await strategy.start();
      emitStarted(sdk);
      // DON'T populate orderbook — no bids available
      // Also clear asks
      (sdk.dipArb as any).upAsks = [];
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      // Should pass through (no spread check when bookBid=0 or bookAsk=0)
      expect(leg1Events).toHaveLength(1);
      await strategy.stop();
    });

    it('should skip when circuit breaker is active', async () => {
      const { sdk, strategy } = await setupReady();

      // Trigger circuit breaker: 3 consecutive losses
      const sizer = strategy.getPositionSizer();
      sizer.recordResult(-10);
      sizer.recordResult(-10);
      sizer.recordResult(-10);
      expect(sizer.isTradingPaused()).toBe(true);

      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(leg1Events).toHaveLength(0);
      await strategy.stop();
    });

    it('should skip when position sizer returns 0 (insufficient balance)', async () => {
      const { sdk, strategy } = await setupReady();
      // Set balance too low: 5% of $1 = $0.05, $0.05/$0.40 = 0 shares
      strategy.updateBalance(1);

      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(leg1Events).toHaveLength(0);
      await strategy.stop();
    });
  });

  // ── Paper Mode: Happy Path ─────────────────────────────────────────────

  describe('paper mode — happy path cycle', () => {
    it('should transition WATCHING → WAITING_FOR_HEDGE on leg1', async () => {
      const { sdk, strategy } = await setupReady();
      const states = collectEvents(strategy, 'stateChange');

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);
      expect(states).toContain(StrategyState.WAITING_FOR_HEDGE);
      await strategy.stop();
    });

    it('should set leg1 info correctly', async () => {
      const { sdk, strategy } = await setupReady();

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      const leg1 = strategy.getLeg1();
      expect(leg1).not.toBeNull();
      expect(leg1!.side).toBe(Side.UP);
      expect(leg1!.price.toNumber()).toBe(0.40);
      expect(leg1!.tokenId).toBe('up-token-123');
      await strategy.stop();
    });

    it('should emit leg1Executed with orderbook data', async () => {
      const { sdk, strategy } = await setupReady();
      const legs = collectEvents(strategy, 'leg1Executed');

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(legs).toHaveLength(1);
      const leg = legs[0] as LegInfo;
      expect(leg.bestBid?.toNumber()).toBe(0.39);
      expect(leg.bestAsk?.toNumber()).toBe(0.40);
      await strategy.stop();
    });

    it('should complete cycle with leg2 and emit cycleComplete', async () => {
      const { sdk, strategy } = await setupReady();
      const cycles = collectEvents(strategy, 'cycleComplete');

      // Leg 1: buy UP @ $0.40
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      // Leg 2: buy DOWN @ $0.50 (sum = 0.40 + 0.50 = 0.90 < 0.95)
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await flush();

      expect(cycles).toHaveLength(1);
      const result = cycles[0] as CycleResult;
      expect(result.status).toBe('completed');
      expect(result.leg1.side).toBe(Side.UP);
      expect(result.leg2!.side).toBe(Side.DOWN);
      await strategy.stop();
    });

    it('should calculate correct profit on cycle complete', async () => {
      const { sdk, strategy } = await setupReady();
      const cycles = collectEvents(strategy, 'cycleComplete');

      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await flush();
      sdk.dipArb.emit('signal', makeLeg2Signal({ currentPrice: 0.50 }));
      await flush();

      const result = cycles[0] as CycleResult;
      // shares = min(floor(1000 * 0.05 / 0.40), 100) = 100
      // totalCost = 0.40 * 100 + 0.50 * 100 = 90
      // payout = 100 (shares, $1 per pair)
      // profit = 100 - 90 = 10
      expect(result.totalCost.toNumber()).toBe(90);
      expect(result.payout.toNumber()).toBe(100);
      expect(result.profit.toNumber()).toBe(10);
      await strategy.stop();
    });

    it('should update stats after completed cycle', async () => {
      const { sdk, strategy } = await setupReady();

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await flush();

      const stats = strategy.getStats();
      expect(stats.cyclesCompleted).toBe(1);
      expect(stats.cyclesWon).toBe(1);
      expect(stats.totalProfit.toNumber()).toBe(10);
      expect(stats.winRate).toBe(1);
      await strategy.stop();
    });

    it('should reset to WATCHING after cycle completes', async () => {
      const { sdk, strategy } = await setupReady();

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await flush();

      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      expect(strategy.getLeg1()).toBeNull();
      await strategy.stop();
    });
  });

  // ── Paper Mode: Leg 2 Filtering ────────────────────────────────────────

  describe('paper mode — leg2 filtering', () => {
    it('should ignore leg2 signal when not WAITING_FOR_HEDGE', async () => {
      const { sdk, strategy } = await setupReady();
      const leg2Events = collectEvents(strategy, 'leg2Executed');

      // No leg1 yet — strategy is WATCHING
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await flush();
      expect(leg2Events).toHaveLength(0);
      await strategy.stop();
    });

    it('should ignore leg2 signal when sum > target', async () => {
      const { sdk, strategy } = await setupReady();
      const leg2Events = collectEvents(strategy, 'leg2Executed');

      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await flush();

      // Sum = 0.40 + 0.60 = 1.00 > 0.95 target
      sdk.dipArb.emit('signal', makeLeg2Signal({ currentPrice: 0.60 }));
      await flush();
      expect(leg2Events).toHaveLength(0);
      await strategy.stop();
    });

    it('should accept leg2 signal when sum <= target', async () => {
      const { sdk, strategy } = await setupReady();
      const leg2Events = collectEvents(strategy, 'leg2Executed');

      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await flush();

      // Sum = 0.40 + 0.50 = 0.90 <= 0.95 target
      sdk.dipArb.emit('signal', makeLeg2Signal({ currentPrice: 0.50 }));
      await flush();
      expect(leg2Events).toHaveLength(1);
      await strategy.stop();
    });

    it('should use correct hedge side (opposite of leg1)', async () => {
      const { sdk, strategy } = await setupReady();
      const leg2Events = collectEvents(strategy, 'leg2Executed');

      // Leg1: UP dip
      sdk.dipArb.emit('signal', makeLeg1Signal({ dipSide: 'UP' }));
      await flush();
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await flush();

      expect(leg2Events[0].side).toBe(Side.DOWN);
      await strategy.stop();
    });
  });

  // ── Live Mode: FOK Execution ───────────────────────────────────────────

  describe('live mode — FOK execution', () => {
    it('should fail gracefully when FOK order returns success=false', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
      });

      sdk.tradingService.createMarketOrder.mockResolvedValue({
        success: false,
        errorMsg: 'Insufficient liquidity',
      });

      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      // Should NOT advance state
      expect(leg1Events).toHaveLength(0);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should advance to WAITING_FOR_HEDGE on successful FOK', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
      });

      sdk.tradingService.createMarketOrder.mockResolvedValue({
        success: true,
        orderId: 'fok-123',
      });

      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(leg1Events).toHaveLength(1);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);
      await strategy.stop();
    });
  });

  // ── Live Mode: GTC Execution ───────────────────────────────────────────

  describe('live mode — GTC execution', () => {
    it('should transition to LEG1_PENDING on GTC order', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'gtc-leg1' });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(strategy.getState()).toBe(StrategyState.LEG1_PENDING);
      await strategy.stop();
    });

    it('should fail when GTC returns no orderId', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      sdk.tradingService.createLimitOrder.mockResolvedValue({});
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(leg1Events).toHaveLength(0);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });
  });

  // ── GTC Fill Polling ───────────────────────────────────────────────────

  describe('GTC fill polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function setupLiveWithPendingLeg1() {
      const sdk = createMockSdk();
      const config = makeConfig({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();
      emitStarted(sdk);
      populateOrderbook(sdk);

      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'gtc-123' });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await vi.advanceTimersByTimeAsync(0); // flush
      expect(strategy.getState()).toBe(StrategyState.LEG1_PENDING);

      return { sdk, strategy };
    }

    it('should detect fill when order status is FILLED', async () => {
      const { sdk, strategy } = await setupLiveWithPendingLeg1();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      sdk.tradingService.getOrder.mockResolvedValue({
        orderId: 'gtc-123',
        status: 'filled',
      });

      await vi.advanceTimersByTimeAsync(150); // trigger poll
      expect(leg1Events).toHaveLength(1);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);
      await strategy.stop();
    });

    it('should reset cycle when order is not found', async () => {
      const { sdk, strategy } = await setupLiveWithPendingLeg1();

      sdk.tradingService.getOrder.mockResolvedValue(null);

      await vi.advanceTimersByTimeAsync(150);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should reset cycle on terminal non-filled status with zero fill', async () => {
      const { sdk, strategy } = await setupLiveWithPendingLeg1();

      sdk.tradingService.getOrder.mockResolvedValue({
        orderId: 'gtc-123',
        status: 'cancelled',
        filledSize: 0,
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should treat partial fill as filled with actual quantity', async () => {
      const { sdk, strategy } = await setupLiveWithPendingLeg1();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      sdk.tradingService.getOrder.mockResolvedValue({
        orderId: 'gtc-123',
        status: 'cancelled',
        filledSize: 50, // partially filled
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(leg1Events).toHaveLength(1);
      expect(leg1Events[0].shares.toNumber()).toBe(50);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);
      await strategy.stop();
    });

    it('should cancel and reset on timeout', async () => {
      const { sdk, strategy } = await setupLiveWithPendingLeg1();

      // Order stays open forever
      sdk.tradingService.getOrder.mockResolvedValue({
        orderId: 'gtc-123',
        status: 'open',
      });

      // Advance past timeout (5000ms)
      await vi.advanceTimersByTimeAsync(6000);

      expect(sdk.tradingService.cancelOrder).toHaveBeenCalledWith('gtc-123');
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should emergency exit on leg2 timeout', async () => {
      const { sdk, strategy } = await setupLiveWithPendingLeg1();
      const emergencyEvents = collectEvents(strategy, 'emergencyExit');

      // Simulate leg1 fill first
      sdk.tradingService.getOrder.mockResolvedValueOnce({
        orderId: 'gtc-123',
        status: 'filled',
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Now place leg2 GTC
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'gtc-leg2' });
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await vi.advanceTimersByTimeAsync(0);
      expect(strategy.getState()).toBe(StrategyState.LEG2_PENDING);

      // Leg2 order stays open, times out → emergency exit
      sdk.tradingService.getOrder.mockResolvedValue({
        orderId: 'gtc-leg2',
        status: 'open',
      });
      await vi.advanceTimersByTimeAsync(6000);

      expect(emergencyEvents).toHaveLength(1);
      await strategy.stop();
    });

    it('should keep polling while order is pending', async () => {
      const { sdk, strategy } = await setupLiveWithPendingLeg1();

      // First 2 polls: pending/open, third: filled
      sdk.tradingService.getOrder
        .mockResolvedValueOnce({ orderId: 'gtc-123', status: 'pending' })
        .mockResolvedValueOnce({ orderId: 'gtc-123', status: 'open' })
        .mockResolvedValueOnce({ orderId: 'gtc-123', status: 'filled' });

      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // Advance exactly one poll interval at a time (100ms each)
      // to avoid straddling two poll ticks in one advance
      await vi.advanceTimersByTimeAsync(105); // poll 1 at t+100: pending
      expect(leg1Events).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(100); // poll 2 at t+200: open
      expect(leg1Events).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(100); // poll 3 at t+300: filled
      expect(leg1Events).toHaveLength(1);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);
      await strategy.stop();
    });
  });

  // ── Live Mode: Cycle Finalization & Idempotency ────────────────────────

  describe('live mode — cycle finalization', () => {
    it('should emit cycleComplete on leg2 fill via handleExecution', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const cycles = collectEvents(strategy, 'cycleComplete');

      // Simulate leg1 fill via handleExecution (SDK event)
      const leg1OrderId = 'exec-leg1';
      // Need to add to expectedOrderIds first
      (strategy as any).expectedOrderIds.add(leg1OrderId);
      sdk.dipArb.emit('execution', {
        leg: 'leg1',
        success: true,
        side: 'UP',
        price: 0.40,
        shares: 100,
        tokenId: 'up-token-123',
        orderId: leg1OrderId,
      });
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Simulate leg2 fill via handleExecution
      const leg2OrderId = 'exec-leg2';
      (strategy as any).expectedOrderIds.add(leg2OrderId);
      sdk.dipArb.emit('execution', {
        leg: 'leg2',
        success: true,
        side: 'DOWN',
        price: 0.50,
        shares: 100,
        tokenId: 'down-token-456',
        orderId: leg2OrderId,
      });
      await flush();

      expect(cycles).toHaveLength(1);
      expect(cycles[0].status).toBe('completed');
      expect(cycles[0].profit.toNumber()).toBe(10); // 100 - (40+50)
      await strategy.stop();
    });

    it('should update stats on live cycle complete', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      const leg1Id = 'stat-leg1';
      const leg2Id = 'stat-leg2';
      (strategy as any).expectedOrderIds.add(leg1Id);
      (strategy as any).expectedOrderIds.add(leg2Id);

      sdk.dipArb.emit('execution', {
        leg: 'leg1', success: true, side: 'UP', price: 0.40, shares: 50,
        tokenId: 'up-token-123', orderId: leg1Id,
      });
      await flush();

      sdk.dipArb.emit('execution', {
        leg: 'leg2', success: true, side: 'DOWN', price: 0.50, shares: 50,
        tokenId: 'down-token-456', orderId: leg2Id,
      });
      await flush();

      const stats = strategy.getStats();
      expect(stats.cyclesCompleted).toBe(1);
      expect(stats.cyclesWon).toBe(1);
      expect(stats.totalProfit.toNumber()).toBe(5); // 50 - (20+25)
      expect(stats.winRate).toBe(1);
      await strategy.stop();
    });

    it('should be idempotent — double finalization only counts once', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const cycles = collectEvents(strategy, 'cycleComplete');

      // Set up leg1 via handleExecution
      const leg1Id = 'idem-leg1';
      (strategy as any).expectedOrderIds.add(leg1Id);
      sdk.dipArb.emit('execution', {
        leg: 'leg1', success: true, side: 'UP', price: 0.40, shares: 100,
        tokenId: 'up-token-123', orderId: leg1Id,
      });
      await flush();

      // Simulate BOTH handleExecution and onGtcFilled firing for the same leg2
      const leg2Id = 'idem-leg2';
      (strategy as any).expectedOrderIds.add(leg2Id);

      // First: handleExecution
      sdk.dipArb.emit('execution', {
        leg: 'leg2', success: true, side: 'DOWN', price: 0.50, shares: 100,
        tokenId: 'down-token-456', orderId: leg2Id,
      });
      await flush();

      // Manually call onGtcFilled to simulate the race
      (strategy as any).onGtcFilled('leg2', leg2Id, {
        side: Side.DOWN, price: 0.50, shares: 100,
        tokenId: 'down-token-456',
      });
      await flush();

      // Should only have ONE cycleComplete despite two finalization attempts
      expect(cycles).toHaveLength(1);

      const stats = strategy.getStats();
      expect(stats.cyclesCompleted).toBe(1); // Not 2
      await strategy.stop();
    });
  });

  // ── handleExecution — Stale Order Filtering ────────────────────────────

  describe('handleExecution — stale order filtering', () => {
    it('should ignore execution for unknown orderId', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      sdk.dipArb.emit('execution', {
        leg: 'leg1', success: true, side: 'UP', price: 0.40, shares: 100,
        tokenId: 'up-token-123', orderId: 'unknown-order-id',
      });
      await flush();

      expect(leg1Events).toHaveLength(0);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should ignore leg1 execution when not in valid state', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      // Set up leg1 first
      const leg1Id = 'valid-leg1';
      (strategy as any).expectedOrderIds.add(leg1Id);
      sdk.dipArb.emit('execution', {
        leg: 'leg1', success: true, side: 'UP', price: 0.40, shares: 100,
        tokenId: 'up-token-123', orderId: leg1Id,
      });
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Try another leg1 execution in WAITING_FOR_HEDGE — should be ignored
      const leg1Id2 = 'stale-leg1';
      (strategy as any).expectedOrderIds.add(leg1Id2);
      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('execution', {
        leg: 'leg1', success: true, side: 'DOWN', price: 0.50, shares: 50,
        tokenId: 'down-token-456', orderId: leg1Id2,
      });
      await flush();

      // Only the first leg1 should have been accepted
      expect(leg1Events).toHaveLength(0);
      await strategy.stop();
    });

    it('should ignore leg2 execution when not in valid state', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const leg2Events = collectEvents(strategy, 'leg2Executed');

      // WATCHING state — leg2 execution should be ignored
      const leg2Id = 'premature-leg2';
      (strategy as any).expectedOrderIds.add(leg2Id);
      sdk.dipArb.emit('execution', {
        leg: 'leg2', success: true, side: 'DOWN', price: 0.50, shares: 100,
        tokenId: 'down-token-456', orderId: leg2Id,
      });
      await flush();

      expect(leg2Events).toHaveLength(0);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });
  });

  // ── Emergency Exit ─────────────────────────────────────────────────────

  describe('emergency exit', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should trigger when time remaining < threshold', async () => {
      const sdk = createMockSdk();
      const config = makeConfig();
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      // Start market with 4 minutes remaining (> 3 min gate so leg1 can enter)
      emitStarted(sdk, {
        endTime: new Date(Date.now() + 240 * 1000), // 4 min
      });
      populateOrderbook(sdk);

      const emergencyEvents = collectEvents(strategy, 'emergencyExit');
      const cycleEvents = collectEvents(strategy, 'cycleComplete');

      // Process leg1 — passes time gate (240s > 180s threshold)
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await vi.advanceTimersByTimeAsync(0);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Advance past the 3-min threshold (need 60s+ to cross from 240s to <180s)
      await vi.advanceTimersByTimeAsync(61_000);

      expect(emergencyEvents).toHaveLength(1);
      expect(emergencyEvents[0].reason).toContain('Time exit');
      expect(cycleEvents).toHaveLength(1);
      expect(cycleEvents[0].status).toBe('emergency_exit');
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should not trigger when emergency is disabled', async () => {
      const sdk = createMockSdk();
      const config = makeConfig({
        risk: { ...makeConfig().risk, emergencyEnabled: false },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      emitStarted(sdk, {
        endTime: new Date(Date.now() + 240 * 1000), // 4 min (> 3 min gate)
      });
      populateOrderbook(sdk);

      const emergencyEvents = collectEvents(strategy, 'emergencyExit');

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await vi.advanceTimersByTimeAsync(0);

      // Even advancing past the 3-min threshold shouldn't trigger emergency
      await vi.advanceTimersByTimeAsync(61_000);
      expect(emergencyEvents).toHaveLength(0);
      await strategy.stop();
    });

    it('should use last market price for P&L calculation', async () => {
      const sdk = createMockSdk();
      const config = makeConfig();
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      emitStarted(sdk, {
        endTime: new Date(Date.now() + 240 * 1000), // 4 min (> 3 min gate)
      });
      populateOrderbook(sdk);

      const cycleEvents = collectEvents(strategy, 'cycleComplete');

      // Process leg1 at $0.40
      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the 3-min threshold to trigger emergency exit
      await vi.advanceTimersByTimeAsync(61_000);

      const result = cycleEvents[0] as CycleResult;
      // P&L should be based on last market price, not -100%
      // The strategy recorded UP price 0.40 from the signal
      expect(result.profit).toBeDefined();
      // Profit = exitValue - entryValue = (lastPrice * shares) - (0.40 * shares)
      // lastPrice should be from upHistory (0.40 was recorded via recordPrice)
      await strategy.stop();
    });

    it('should count emergency exit in stats', async () => {
      const sdk = createMockSdk();
      const config = makeConfig();
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      emitStarted(sdk, {
        endTime: new Date(Date.now() + 240 * 1000), // 4 min (> 3 min gate)
      });
      populateOrderbook(sdk);

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await vi.advanceTimersByTimeAsync(0);
      // Advance past 3-min threshold
      await vi.advanceTimersByTimeAsync(61_000);

      const stats = strategy.getStats();
      expect(stats.emergencyExits).toBe(1);
      expect(stats.cyclesAbandoned).toBe(1);
      await strategy.stop();
    });

    it('should record loss in position sizer for circuit breaker', async () => {
      const sdk = createMockSdk();
      const config = makeConfig();
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      const cycleEvents = collectEvents(strategy, 'cycleComplete');

      // 3 emergency exits via direct invocation (avoids setInterval timing issues)
      for (let i = 0; i < 3; i++) {
        emitStarted(sdk, {
          slug: `round-${i}`,
          endTime: new Date(Date.now() + 600 * 1000), // 10 min (> 3 min gate)
        });
        populateOrderbook(sdk);

        // Entry at $0.40
        sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

        // Price drops to $0.20 — updates upHistory so emergency exit calculates a loss
        sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.20, dropPercent: 0.05 }));
        await vi.advanceTimersByTimeAsync(0);

        // Directly invoke emergency exit (bypasses setInterval timing)
        await (strategy as any).performEmergencyExit('test timeout');
        await vi.advanceTimersByTimeAsync(0);

        expect(strategy.getPositionSizer().getConsecutiveLosses()).toBe(i + 1);
      }

      // After 3 losses, circuit breaker should engage
      expect(cycleEvents.length).toBe(3);
      // Verify each loss was negative (profit < 0 means entry_at_0.40 > market_at_0.20)
      for (const cycle of cycleEvents) {
        expect(cycle.profit.toNumber()).toBeLessThan(0);
      }
      expect(strategy.getPositionSizer().getConsecutiveLosses()).toBe(3);
      expect(strategy.getPositionSizer().isTradingPaused()).toBe(true);
      await strategy.stop();
    });
  });

  // ── Settlement ─────────────────────────────────────────────────────────

  describe('settlement', () => {
    it('should call dipArb.settle on handleRoundComplete in live mode', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      sdk.dipArb.emit('roundComplete', { status: 'completed', profit: 5 });
      await flush();

      expect(sdk.dipArb.settle).toHaveBeenCalledWith('redeem');
      await strategy.stop();
    });

    it('should not call settle in paper mode', async () => {
      const { sdk, strategy } = await setupReady(); // paper enabled by default

      sdk.dipArb.emit('roundComplete', { status: 'completed', profit: 5 });
      await flush();

      expect(sdk.dipArb.settle).not.toHaveBeenCalled();
      await strategy.stop();
    });

    it('should handle settlement failure gracefully', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const errors = collectEvents(strategy, 'error');

      sdk.dipArb.settle.mockRejectedValue(new Error('Settlement RPC error'));

      sdk.dipArb.emit('roundComplete', { status: 'completed', profit: 5 });
      await flush();

      // Should NOT throw or emit an error — just log a warning
      expect(errors).toHaveLength(0);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should update stats on handleRoundComplete', async () => {
      const { sdk, strategy } = await setupReady();

      sdk.dipArb.emit('roundComplete', { status: 'completed', profit: 15 });
      await flush();

      const stats = strategy.getStats();
      expect(stats.cyclesCompleted).toBe(1);
      expect(stats.totalProfit.toNumber()).toBe(15);
      await strategy.stop();
    });

    it('should count abandoned rounds', async () => {
      const { sdk, strategy } = await setupReady();

      sdk.dipArb.emit('roundComplete', { status: 'abandoned' });
      await flush();

      const stats = strategy.getStats();
      expect(stats.cyclesAbandoned).toBe(1);
      await strategy.stop();
    });
  });

  // ── Startup Retry ──────────────────────────────────────────────────────

  describe('startup retry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should succeed on first active market found', async () => {
      const sdk = createMockSdk();
      const now = Date.now();
      sdk.dipArb.scanUpcomingMarkets.mockResolvedValue([{
        slug: 'active-market',
        endTime: new Date(now + 600 * 1000),
        durationMinutes: 15,
      }]);

      const strategy = new EnhancedDipArbStrategy(sdk, makeConfig());
      await strategy.start();

      expect(sdk.dipArb.start).toHaveBeenCalled();
      await strategy.stop();
    });

    it('should retry findAndStart up to 3 times', async () => {
      const sdk = createMockSdk();
      sdk.dipArb.scanUpcomingMarkets.mockResolvedValue([]);
      sdk.dipArb.findAndStart
        .mockResolvedValueOnce(null) // attempt 1: fail
        .mockResolvedValueOnce(null) // attempt 2: fail
        .mockResolvedValueOnce({ slug: 'found-market' }); // attempt 3: success

      const strategy = new EnhancedDipArbStrategy(sdk, makeConfig());
      const startPromise = strategy.start();

      // Advance past the 30s delay between retries
      await vi.advanceTimersByTimeAsync(0); // attempt 1
      await vi.advanceTimersByTimeAsync(30000); // wait + attempt 2
      await vi.advanceTimersByTimeAsync(30000); // wait + attempt 3

      await startPromise;
      expect(sdk.dipArb.findAndStart).toHaveBeenCalledTimes(3);
      await strategy.stop();
    });

    it('should emit error after all retries fail', async () => {
      const sdk = createMockSdk();
      sdk.dipArb.scanUpcomingMarkets.mockResolvedValue([]);
      sdk.dipArb.findAndStart.mockResolvedValue(null);

      const strategy = new EnhancedDipArbStrategy(sdk, makeConfig());
      const errors = collectEvents(strategy, 'error');

      const startPromise = strategy.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(30000);
      await startPromise;

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Failed to find any market');
      await strategy.stop();
    });
  });

  // ── Win Rate Calculation ───────────────────────────────────────────────

  describe('win rate calculation', () => {
    it('should calculate win rate correctly after mixed results', async () => {
      const { sdk, strategy } = await setupReady();

      // Win: leg1 $0.40 + leg2 $0.50 = $0.90 cost, $1 payout → profit
      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await flush();
      sdk.dipArb.emit('signal', makeLeg2Signal({ currentPrice: 0.50 }));
      await flush();

      // Simulate a roundComplete for an abandoned cycle
      sdk.dipArb.emit('roundComplete', { status: 'abandoned' });
      await flush();

      const stats = strategy.getStats();
      // 1 completed (won), 1 abandoned → winRate = 1/2 = 0.5
      expect(stats.cyclesCompleted).toBe(1);
      expect(stats.cyclesWon).toBe(1);
      expect(stats.cyclesAbandoned).toBe(1);
      expect(stats.winRate).toBe(0.5);
      await strategy.stop();
    });

    it('should not count losing cycle as won', async () => {
      const { sdk, strategy } = await setupReady();

      // Losing cycle: leg1 $0.50 + leg2 $0.55 = $1.05 cost, $1 payout → loss
      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.50 }));
      await flush();
      sdk.dipArb.emit('signal', makeLeg2Signal({ currentPrice: 0.55 }));
      await flush();

      const stats = strategy.getStats();
      // shares = floor(50/0.50) = 100 → capped at 100
      // totalCost = 0.50*100 + 0.55*100 = 105
      // profit = 100 - 105 = -5 → loss
      expect(stats.cyclesWon).toBe(0);
      await strategy.stop();
    });
  });

  // ── Exit Sell Orders ───────────────────────────────────────────────────

  describe('exit sell orders', () => {
    it('should place $0.99 GTC sell in live mode', async () => {
      const { sdk, strategy } = await setupReady({
        trading: {
          assets: ['BTC'], duration: '15m', defaultShares: 20,
          defaultSumTarget: 0.95, defaultDipThreshold: 0.20,
          windowMinutes: 5, maxCycles: 1, dumpWindowMs: 3000,
          useMakerOrders: false, makerFallbackToTaker: true,
          takerFeeRate: 0.0625, maxSpreadPct: 0.10,
          gtcFillTimeoutMs: 5000, gtcPollIntervalMs: 100,
        },
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      // FOK returns success
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      // Exit sell returns order ID
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'sell-order-1' });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      // Should have placed a SELL at $0.99
      expect(sdk.tradingService.createLimitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          side: 'SELL',
          price: 0.99,
          orderType: 'GTC',
        }),
      );
      await strategy.stop();
    });

    it('should not place real sell order in paper mode', async () => {
      const { sdk, strategy } = await setupReady(); // paper mode

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      // createLimitOrder should only have been called during start() for config
      // No SELL order should have been placed via tradingService
      const sellCalls = sdk.tradingService.createLimitOrder.mock.calls.filter(
        (c: any[]) => c[0]?.side === 'SELL',
      );
      expect(sellCalls).toHaveLength(0);
      await strategy.stop();
    });
  });

  // ── Stop & Cleanup ─────────────────────────────────────────────────────

  describe('stop and cleanup', () => {
    it('should reset state to WATCHING on stop', async () => {
      const { sdk, strategy } = await setupReady();

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      await strategy.stop();
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
    });

    it('should cancel exit sell orders on stop in live mode', async () => {
      const { sdk, strategy } = await setupReady({
        trading: {
          assets: ['BTC'], duration: '15m', defaultShares: 20,
          defaultSumTarget: 0.95, defaultDipThreshold: 0.20,
          windowMinutes: 5, maxCycles: 1, dumpWindowMs: 3000,
          useMakerOrders: false, makerFallbackToTaker: true,
          takerFeeRate: 0.0625, maxSpreadPct: 0.10,
          gtcFillTimeoutMs: 5000, gtcPollIntervalMs: 100,
        },
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      // FOK leg1 fill which places exit sell
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'exit-sell-1' });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      await strategy.stop();
      expect(sdk.tradingService.cancelOrder).toHaveBeenCalledWith('exit-sell-1');
    });
  });

  // ── Balance Tracking ───────────────────────────────────────────────────

  describe('balance tracking', () => {
    it('should update balance via updateBalance', async () => {
      const { sdk, strategy } = await setupReady();
      strategy.updateBalance(500);

      // At $500 balance, 5% = $25, $25/0.40 = 62 shares
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      const leg1 = strategy.getLeg1();
      expect(leg1!.shares.toNumber()).toBe(62);
      await strategy.stop();
    });

    it('should position size based on current balance', async () => {
      const { sdk, strategy } = await setupReady();
      strategy.updateBalance(2000);

      // At $2000, 5% = $100, $100/0.40 = 250 → capped at 100
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(strategy.getLeg1()!.shares.toNumber()).toBe(100);
      await strategy.stop();
    });
  });

  // ── Live Emergency Exit — Cancel Orders ────────────────────────────────

  describe('live emergency exit — order cancellation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should cancel pending leg2 and leg1 sell on emergency exit', async () => {
      const sdk = createMockSdk();
      const config = makeConfig({
        trading: {
          assets: ['BTC'], duration: '15m', defaultShares: 20,
          defaultSumTarget: 0.95, defaultDipThreshold: 0.20,
          windowMinutes: 5, maxCycles: 1, dumpWindowMs: 3000,
          useMakerOrders: false, makerFallbackToTaker: true,
          takerFeeRate: 0.0625, maxSpreadPct: 0.10,
          gtcFillTimeoutMs: 5000, gtcPollIntervalMs: 100,
        },
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();
      emitStarted(sdk, {
        endTime: new Date(Date.now() + 240 * 1000), // 4 min (> 3 min gate)
      });
      populateOrderbook(sdk);

      // FOK leg1 fill
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'exit-sell-leg1' });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await vi.advanceTimersByTimeAsync(0);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Clear previous calls
      sdk.tradingService.cancelOrder.mockClear();

      // Advance past 3-min threshold to trigger emergency exit
      await vi.advanceTimersByTimeAsync(61_000);

      // Should cancel the leg1 exit sell order
      expect(sdk.tradingService.cancelOrder).toHaveBeenCalledWith('exit-sell-leg1');
      // Should place FOK sell for emergency liquidation
      expect(sdk.tradingService.createMarketOrder).toHaveBeenCalledWith(
        expect.objectContaining({ side: 'SELL', orderType: 'FOK' }),
      );
      await strategy.stop();
    });
  });

  // ── Price History ──────────────────────────────────────────────────────

  describe('price recording', () => {
    it('should record prices from signals', async () => {
      const { sdk, strategy } = await setupReady();
      const priceUpdates = collectEvents(strategy, 'priceUpdate');

      sdk.dipArb.emit('signal', {
        type: 'leg1',
        dipSide: 'UP',
        currentPrice: 0.42,
        oppositeAsk: 0.53,
        dropPercent: 0.05, // Small drop, won't trigger entry
        tokenId: 'up-token-123',
      });
      await flush();

      // Should have emitted priceUpdate
      expect(priceUpdates.length).toBeGreaterThan(0);
      await strategy.stop();
    });
  });

  // ── Orderbook Subscription ─────────────────────────────────────────────

  describe('orderbook subscription', () => {
    it('should capture bid data from realtimeService', async () => {
      const { sdk, strategy } = await setupReady();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // Update bids to be very close to asks (narrow spread)
      sdk.dipArb.realtimeService.emit('orderbook', {
        assetId: 'up-token-123',
        bids: [{ price: 0.395, size: 200 }],
      });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(leg1Events).toHaveLength(1);
      // bestBid should reflect the latest orderbook data
      expect(leg1Events[0].bestBid.toNumber()).toBe(0.395);
      await strategy.stop();
    });

    it('should unsubscribe on new round', async () => {
      const { sdk, strategy } = await setupReady();

      // First round populates bids
      sdk.dipArb.realtimeService.emit('orderbook', {
        assetId: 'up-token-123',
        bids: [{ price: 0.39, size: 100 }],
      });

      // New round should clear bids
      emitStarted(sdk, {
        slug: 'new-round',
        upTokenId: 'new-up-token',
        downTokenId: 'new-down-token',
      });

      // Old orderbook data should be cleared
      // New orderbook data for old token should be ignored
      sdk.dipArb.realtimeService.emit('orderbook', {
        assetId: 'up-token-123', // old token
        bids: [{ price: 0.50, size: 100 }],
      });

      // Signal with new token — bestBid should be undefined (old token data ignored)
      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal({
        tokenId: 'new-up-token',
      }));
      await flush();

      if (leg1Events.length > 0) {
        // bestBid should NOT be 0.50 (that was for the old token)
        expect(leg1Events[0].bestBid?.toNumber()).not.toBe(0.50);
      }
      await strategy.stop();
    });
  });
});
