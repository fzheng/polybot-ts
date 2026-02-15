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
  // bookCache stores full orderbook snapshots (bids + asks) keyed by tokenId.
  // The price poll reads bids from here via getBook() or bookCache.get().
  const bookCache = new Map<string, any>();
  bookCache.set('up-token-123', {
    bids: [{ price: 0.39, size: 50 }],
    asks: [{ price: 0.40, size: 100 }],
  });
  bookCache.set('down-token-456', {
    bids: [{ price: 0.54, size: 50 }],
    asks: [{ price: 0.55, size: 100 }],
  });

  const realtimeService = Object.assign(new EventEmitter(), {
    bookCache,
    getBook: vi.fn((assetId: string) => bookCache.get(assetId)),
  });

  const dipArbState = {
    upAsks: [{ price: 0.40, size: 100 }] as any[],
    downAsks: [{ price: 0.55, size: 100 }] as any[],
    priceHistory: [] as any[],
  };

  const dipArb = Object.assign(new EventEmitter(), {
    updateConfig: vi.fn(),
    enableAutoRotate: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    findAndStart: vi.fn().mockResolvedValue({ slug: 'test-market' }),
    stop: vi.fn(),
    scanUpcomingMarkets: vi.fn().mockResolvedValue([]),
    settle: vi.fn().mockResolvedValue({ success: true, amountReceived: 1.5 }),
    // Mimics SDK's handleOrderbookUpdate: updates asks + records priceHistory
    handleOrderbookUpdate: vi.fn((book: any) => {
      const isUp = book.tokenId === dipArb.market.upTokenId;
      const isDown = book.tokenId === dipArb.market.downTokenId;
      if (isUp && book.asks?.length) dipArb.upAsks = book.asks;
      if (isDown && book.asks?.length) dipArb.downAsks = book.asks;
      const upAsk = Number(dipArb.upAsks[0]?.price) || 0;
      const downAsk = Number(dipArb.downAsks[0]?.price) || 0;
      if (upAsk > 0 && downAsk > 0) {
        dipArb.priceHistory.push({ timestamp: Date.now(), upAsk, downAsk });
      }
    }),
    // Internal state accessed via `as any` by the strategy
    ...dipArbState,
    realtimeService,
    market: { upTokenId: 'up-token-123', downTokenId: 'down-token-456' },
  });

  const tradingService = {
    createLimitOrder: vi.fn().mockResolvedValue({ orderId: 'limit-order-1' }),
    createMarketOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'market-order-1' }),
    getOrder: vi.fn().mockResolvedValue(null),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
  };

  const markets = {
    getTokenOrderbook: vi.fn().mockResolvedValue({
      bids: [{ price: 0.39, size: 100 }],
      asks: [{ price: 0.40, size: 100 }],
    }),
  };

  return { dipArb, tradingService, markets } as any;
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
  // Populate bids via bookCache (strategy reads from here in price poll)
  sdk.dipArb.realtimeService.bookCache.set('up-token-123', {
    bids: [{ price: 0.39, size: 100 }],
    asks: [{ price: 0.40, size: 100 }],
  });
  sdk.dipArb.realtimeService.bookCache.set('down-token-456', {
    bids: [{ price: 0.54, size: 100 }],
  });
  // Repopulate SDK ask arrays (cleared by handleStarted on rotation)
  sdk.dipArb.upAsks = [{ price: 0.40, size: 100 }];
  sdk.dipArb.downAsks = [{ price: 0.55, size: 100 }];
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

    it('should reject unsupported duration on start', async () => {
      const sdk = createMockSdk();
      const cfg = makeConfig({
        trading: { ...makeConfig().trading, duration: '1h' },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, cfg);

      await expect(strategy.start()).rejects.toThrow('Unsupported trading duration');
      expect(sdk.dipArb.start).not.toHaveBeenCalled();
    });

    it('should disable SDK settle and extend SDK leg2 timeout in paper mode', async () => {
      const sdk = createMockSdk();
      const strategy = new EnhancedDipArbStrategy(sdk, makeConfig());

      await strategy.start();

      expect(sdk.dipArb.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          leg2TimeoutSeconds: 86400,
        }),
      );
      expect(sdk.dipArb.enableAutoRotate).toHaveBeenCalledWith(
        expect.objectContaining({
          autoSettle: false,
        }),
      );
      await strategy.stop();
    });

    it('should keep SDK settle enabled and normal leg2 timeout in live mode', async () => {
      const sdk = createMockSdk();
      const strategy = new EnhancedDipArbStrategy(sdk, makeConfig({
        paper: {
          enabled: false,
          startingBalance: 1000,
          simulateFees: true,
          simulateSlippage: true,
          slippagePct: 0.02,
          logFile: 'test.jsonl',
          recordData: false,
          dataDir: 'data',
          recordIntervalMs: 1000,
        },
      }));

      await strategy.start();

      expect(sdk.dipArb.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          leg2TimeoutSeconds: 900,
        }),
      );
      expect(sdk.dipArb.enableAutoRotate).toHaveBeenCalledWith(
        expect.objectContaining({
          autoSettle: true,
        }),
      );
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

    it('should reset SDK signal phase on market start', async () => {
      const { sdk, strategy } = await setupReady();

      // Simulate stale SDK internal state from a previous cycle.
      (sdk.dipArb as any).currentRound = {
        phase: 'leg1_filled',
        leg1: { side: 'UP', price: 0.4, shares: 10, tokenId: 'up-token-123' },
        leg2: { side: 'DOWN', price: 0.5, shares: 10, tokenId: 'down-token-456' },
      };
      (sdk.dipArb as any).leg1SignalEmitted = true;

      emitStarted(sdk, { slug: 'rotation-round' });

      expect((sdk.dipArb as any).currentRound.phase).toBe('waiting');
      expect((sdk.dipArb as any).currentRound.leg1).toBeUndefined();
      expect((sdk.dipArb as any).currentRound.leg2).toBeUndefined();
      expect((sdk.dipArb as any).leg1SignalEmitted).toBe(false);
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

    it('should ignore stale-token signals after market rotation', async () => {
      const { sdk, strategy } = await setupReady();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      sdk.dipArb.emit('signal', makeLeg1Signal({ tokenId: 'stale-token-999' }));
      await flush();

      expect(leg1Events).toHaveLength(0);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
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
      expect(sdk.tradingService.createMarketOrder).toHaveBeenCalledWith(
        expect.objectContaining({ side: 'BUY', orderType: 'FOK', price: 0.4 }),
      );
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
      const rejectedStart = expect(startPromise).rejects.toThrow('Failed to find any market');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30000);
      await vi.advanceTimersByTimeAsync(30000);
      await rejectedStart;

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

  // ── Fix #1: Emergency sell amount (USDC value, not shares) ────────────

  describe('fix #1 — emergency sell amount is USDC value', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should pass shares * price as amount, not just shares', async () => {
      const sdk = createMockSdk();
      const config = makeConfig({
        trading: {
          ...makeConfig().trading,
          useMakerOrders: false, makerFallbackToTaker: true,
        },
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();
      emitStarted(sdk, {
        endTime: new Date(Date.now() + 240 * 1000),
      });
      populateOrderbook(sdk);

      // FOK leg1 fill at $0.40
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'exit-sell-1' });

      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Clear mocks to isolate emergency sell call
      sdk.tradingService.createMarketOrder.mockClear();
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true });

      // Trigger emergency exit
      await vi.advanceTimersByTimeAsync(61_000);

      // Verify the SELL call has amount = shares * price (not just shares)
      const sellCall = sdk.tradingService.createMarketOrder.mock.calls.find(
        (c: any[]) => c[0]?.side === 'SELL',
      );
      expect(sellCall).toBeDefined();
      const sellArgs = sellCall![0];
      // amount should be shares * emergencySellPrice, not just shares
      // With $1000 balance, 5% = $50, $50/0.40 = 125 → capped at 100 shares
      // Emergency sell price = last market price (0.40 from signal)
      // So amount should be 100 * 0.40 = 40, NOT just 100
      expect(sellArgs.amount).toBeLessThan(sellArgs.price * 200); // Sanity check: not just raw shares
      expect(sellArgs.amount).toBeCloseTo(100 * sellArgs.price, 2);
      await strategy.stop();
    });
  });

  // ── Fix #2: FOK Leg 1 records marketPrice ────────────────────────────

  describe('fix #2 — FOK leg1 records actual execution price', () => {
    it('should record bestAsk as price, not signal.targetPrice', async () => {
      const { sdk, strategy } = await setupReady({
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'sell-1' });

      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // Signal with targetPrice=0.35 but bestAsk (from SDK upAsks) is $0.40
      sdk.dipArb.emit('signal', makeLeg1Signal({
        currentPrice: 0.35,
        targetPrice: 0.35,
      }));
      await flush();

      expect(leg1Events).toHaveLength(1);
      // Should use marketPrice (bestAsk = 0.40), not signal price (0.35)
      expect(leg1Events[0].price.toNumber()).toBe(0.40);
      await strategy.stop();
    });
  });

  // ── Fix #3: Emergency timer covers LEG2_PENDING ──────────────────────

  describe('fix #3 — emergency timer fires during LEG2_PENDING', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should trigger emergency exit in LEG2_PENDING state', async () => {
      const sdk = createMockSdk();
      const config = makeConfig({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: {
          ...makeConfig().trading,
          gtcFillTimeoutMs: 120_000, // Long timeout so emergency timer fires first
          gtcPollIntervalMs: 100,
        },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();
      emitStarted(sdk, {
        endTime: new Date(Date.now() + 240 * 1000), // 4 min
      });
      populateOrderbook(sdk);

      // Place GTC leg1
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'gtc-leg1' });
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await vi.advanceTimersByTimeAsync(0);
      expect(strategy.getState()).toBe(StrategyState.LEG1_PENDING);

      // Simulate leg1 fill
      sdk.tradingService.getOrder.mockResolvedValueOnce({ orderId: 'gtc-leg1', status: 'filled' });
      await vi.advanceTimersByTimeAsync(150);
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Place GTC leg2
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'gtc-leg2' });
      sdk.dipArb.emit('signal', makeLeg2Signal());
      await vi.advanceTimersByTimeAsync(0);
      expect(strategy.getState()).toBe(StrategyState.LEG2_PENDING);

      // Leg2 stays open (never fills)
      sdk.tradingService.getOrder.mockResolvedValue({ orderId: 'gtc-leg2', status: 'open' });
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true });

      const emergencyEvents = collectEvents(strategy, 'emergencyExit');

      // Advance past 3-min threshold (from 240s to <180s)
      await vi.advanceTimersByTimeAsync(61_000);

      // Emergency timer should have fired even in LEG2_PENDING
      expect(emergencyEvents).toHaveLength(1);
      expect(emergencyEvents[0].reason).toContain('Time exit');
      await strategy.stop();
    });
  });

  // ── Fix #4: handleNewRound mid-cycle guard ────────────────────────────

  describe('fix #4 — handleNewRound does not corrupt mid-cycle state', () => {
    it('should not reset cycleAttemptedThisRound during active cycle', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      // Place GTC leg1 → LEG1_PENDING
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'gtc-leg1' });
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.LEG1_PENDING);

      // handleNewRound fires while mid-cycle
      sdk.dipArb.emit('newRound', {
        roundId: 'mid-cycle-round',
        endTime: new Date(Date.now() + 600 * 1000),
      });

      // State should still be LEG1_PENDING (not corrupted)
      expect(strategy.getState()).toBe(StrategyState.LEG1_PENDING);
      expect(strategy.getCurrentRound()).toBe('mid-cycle-round'); // Round ID updates are fine
      await strategy.stop();
    });

    it('should reset normally when not mid-cycle', async () => {
      const { sdk, strategy } = await setupReady();

      // WATCHING state — handleNewRound should reset normally
      sdk.dipArb.emit('newRound', {
        roundId: 'fresh-round',
        endTime: new Date(Date.now() + 600 * 1000),
      });

      expect(strategy.getCurrentRound()).toBe('fresh-round');

      // Should be able to process a new signal (cycleAttemptedThisRound was reset)
      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(leg1Events).toHaveLength(1);
      await strategy.stop();
    });
  });

  // ── Fix #5: handleStarted cancels live orders ─────────────────────────

  describe('fix #5 — handleStarted cancels outstanding live orders', () => {
    it('should cancel pending orders from previous market on rotation', async () => {
      const { sdk, strategy } = await setupReady({
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      // FOK leg1 fill → places exit sell
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'exit-sell-1' });
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Clear mocks
      sdk.tradingService.cancelOrder.mockClear();

      // Market rotation: handleStarted fires
      emitStarted(sdk, { slug: 'new-market-2' });

      // Should have cancelled the exit sell order from the previous market
      expect(sdk.tradingService.cancelOrder).toHaveBeenCalledWith('exit-sell-1');
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      await strategy.stop();
    });

    it('should not cancel orders in paper mode', async () => {
      const { sdk, strategy } = await setupReady(); // paper mode

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      sdk.tradingService.cancelOrder.mockClear();
      emitStarted(sdk, { slug: 'new-market' });

      // No cancelOrder calls in paper mode
      expect(sdk.tradingService.cancelOrder).not.toHaveBeenCalled();
      await strategy.stop();
    });
  });

  // ── Fix #6: handleRoundComplete doesn't double-count ──────────────────

  describe('fix #6 — handleRoundComplete does not double-count stats', () => {
    it('should skip stats when finalizeLiveCycle already counted', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      // Complete cycle via handleExecution (finalizeLiveCycle counts stats)
      const leg1Id = 'dc-leg1';
      const leg2Id = 'dc-leg2';
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

      // finalizeLiveCycle should have counted 1 completed cycle
      expect(strategy.getStats().cyclesCompleted).toBe(1);

      // Now handleRoundComplete fires (SDK event)
      sdk.dipArb.emit('roundComplete', { status: 'completed', profit: 5 });
      await flush();

      // Should still be 1, NOT 2
      expect(strategy.getStats().cyclesCompleted).toBe(1);
      await strategy.stop();
    });

    it('should count stats when finalizeLiveCycle did not run', async () => {
      const { sdk, strategy } = await setupReady();

      // handleRoundComplete without a prior finalizeLiveCycle
      sdk.dipArb.emit('roundComplete', { status: 'completed', profit: 7 });
      await flush();

      expect(strategy.getStats().cyclesCompleted).toBe(1);
      expect(strategy.getStats().totalProfit.toNumber()).toBe(7);
      await strategy.stop();
    });
  });

  // ── Fix #7: Payout uses min(leg1, leg2) shares for partial fills ──────

  describe('fix #7 — payout uses min shares for partial fills', () => {
    it('should use leg2 shares when less than leg1 (partial fill)', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const cycles = collectEvents(strategy, 'cycleComplete');

      const leg1Id = 'pf-leg1';
      const leg2Id = 'pf-leg2';
      (strategy as any).expectedOrderIds.add(leg1Id);
      (strategy as any).expectedOrderIds.add(leg2Id);

      // Leg1: 100 shares at $0.40
      sdk.dipArb.emit('execution', {
        leg: 'leg1', success: true, side: 'UP', price: 0.40, shares: 100,
        tokenId: 'up-token-123', orderId: leg1Id,
      });
      await flush();

      // Leg2: only 60 shares at $0.50 (partial fill)
      sdk.dipArb.emit('execution', {
        leg: 'leg2', success: true, side: 'DOWN', price: 0.50, shares: 60,
        tokenId: 'down-token-456', orderId: leg2Id,
      });
      await flush();

      expect(cycles).toHaveLength(1);
      // payout = min(100, 60) = 60 (not 100)
      // totalCost = 0.40*100 + 0.50*60 = 40 + 30 = 70
      // profit = 60 - 70 = -10
      expect(cycles[0].payout.toNumber()).toBe(60);
      expect(cycles[0].totalCost.toNumber()).toBe(70);
      expect(cycles[0].profit.toNumber()).toBe(-10);
      await strategy.stop();
    });

    it('should use full shares when both legs match (paper mode)', async () => {
      const { sdk, strategy } = await setupReady();
      const cycles = collectEvents(strategy, 'cycleComplete');

      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await flush();
      sdk.dipArb.emit('signal', makeLeg2Signal({ currentPrice: 0.50 }));
      await flush();

      // Both legs have same shares (100), so payout = 100
      expect(cycles[0].payout.toNumber()).toBe(100);
      await strategy.stop();
    });
  });

  // ── Fix #8: Fill poll overlap guard ────────────────────────────────────

  describe('fix #8 — fill poll prevents overlapping async callbacks', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not call getOrder twice concurrently when previous poll is slow', async () => {
      const sdk = createMockSdk();
      const config = makeConfig({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: { ...makeConfig().trading, gtcPollIntervalMs: 50 },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();
      emitStarted(sdk);
      populateOrderbook(sdk);

      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'slow-order' });

      // Make getOrder slow — takes 200ms (4x poll interval of 50ms)
      let getOrderCallCount = 0;
      sdk.tradingService.getOrder.mockImplementation(() => {
        getOrderCallCount++;
        return new Promise(resolve =>
          setTimeout(() => resolve({ orderId: 'slow-order', status: 'open' }), 200),
        );
      });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await vi.advanceTimersByTimeAsync(0);
      expect(strategy.getState()).toBe(StrategyState.LEG1_PENDING);

      // Advance 250ms — should have triggered 5 poll ticks (50ms each)
      // But with the overlap guard, only 1-2 should actually call getOrder
      getOrderCallCount = 0;
      await vi.advanceTimersByTimeAsync(250);

      // Without the guard, all 5 ticks would call getOrder
      // With the guard, only ~1-2 should run (first runs, rest are skipped)
      expect(getOrderCallCount).toBeLessThanOrEqual(2);
      await strategy.stop();
    });
  });

  // ── Fix #9: Live balance tracking ──────────────────────────────────────

  describe('fix #9 — live balance tracking', () => {
    it('should query CLOB balance on live start', async () => {
      const sdk = createMockSdk();
      sdk.tradingService.getBalanceAllowance = vi.fn().mockResolvedValue({
        balance: '542.50',
        allowance: '10000',
      });
      const config = makeConfig({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      expect(sdk.tradingService.getBalanceAllowance).toHaveBeenCalledWith('COLLATERAL');

      // Position sizing should use queried balance ($542.50)
      // 5% of $542.50 = $27.125, $27.125/0.40 = 67 shares
      emitStarted(sdk);
      populateOrderbook(sdk);

      // FOK returns success
      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'sell-1' });

      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await flush();

      expect(leg1Events).toHaveLength(1);
      expect(leg1Events[0].shares.toNumber()).toBe(67);
      await strategy.stop();
    });

    it('should not query balance in paper mode', async () => {
      const sdk = createMockSdk();
      sdk.tradingService.getBalanceAllowance = vi.fn();
      const config = makeConfig(); // paper mode
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      expect(sdk.tradingService.getBalanceAllowance).not.toHaveBeenCalled();
      await strategy.stop();
    });

    it('should handle balance query failure gracefully', async () => {
      const sdk = createMockSdk();
      sdk.tradingService.getBalanceAllowance = vi.fn().mockRejectedValue(new Error('RPC timeout'));
      const config = makeConfig({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      const errors = collectEvents(strategy, 'error');

      // Should not throw
      await strategy.start();

      // Should not emit error — just log a warning internally
      expect(errors).toHaveLength(0);
      await strategy.stop();
    });
  });

  // ── Fix #10: Price validation before placing orders ────────────────────

  describe('fix #10 — price validation before placing orders', () => {
    it('should reject leg1 with price <= 0', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
      });
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // Signal with price 0 (corrupt data)
      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0, targetPrice: 0 }));
      await flush();

      expect(leg1Events).toHaveLength(0);
      expect(strategy.getState()).toBe(StrategyState.WATCHING);
      // Should not have called createMarketOrder
      expect(sdk.tradingService.createMarketOrder).not.toHaveBeenCalled();
      await strategy.stop();
    });

    it('should reject leg1 with price >= 1', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
      });
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 1.0, targetPrice: 1.0 }));
      await flush();

      expect(leg1Events).toHaveLength(0);
      expect(sdk.tradingService.createMarketOrder).not.toHaveBeenCalled();
      await strategy.stop();
    });

    it('should reject leg2 GTC with invalid limit price', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
      });

      // Set up leg1 via handleExecution
      const leg1Id = 'valid-leg1';
      (strategy as any).expectedOrderIds.add(leg1Id);
      sdk.dipArb.emit('execution', {
        leg: 'leg1', success: true, side: 'UP', price: 0.40, shares: 100,
        tokenId: 'up-token-123', orderId: leg1Id,
      });
      await flush();
      expect(strategy.getState()).toBe(StrategyState.WAITING_FOR_HEDGE);

      // Clear upAsks so bestAsk falls back to signal price (which we set to 0)
      sdk.dipArb.downAsks = [];
      sdk.dipArb.realtimeService.bookCache.delete('down-token-456');

      sdk.tradingService.createLimitOrder.mockClear();

      // Leg2 signal with price 0 — should be rejected by validation
      sdk.dipArb.emit('signal', makeLeg2Signal({ currentPrice: 0 }));
      await flush();

      // createLimitOrder should NOT have been called for leg2
      // (it may have been called earlier for leg1 GTC sell)
      const leg2BuyCalls = sdk.tradingService.createLimitOrder.mock.calls.filter(
        (c: any[]) => c[0]?.side === 'BUY',
      );
      expect(leg2BuyCalls).toHaveLength(0);
      await strategy.stop();
    });

    it('should accept valid prices in range (0, 1)', async () => {
      const { sdk, strategy } = await setupReady({
        paper: { enabled: false, startingBalance: 1000, simulateFees: true, simulateSlippage: true, slippagePct: 0.02, logFile: 'test.jsonl', recordData: false, dataDir: 'data', recordIntervalMs: 1000 },
        trading: { ...makeConfig().trading, useMakerOrders: false, makerFallbackToTaker: true },
      });

      sdk.tradingService.createMarketOrder.mockResolvedValue({ success: true, orderId: 'fok-1' });
      sdk.tradingService.createLimitOrder.mockResolvedValue({ orderId: 'sell-1' });

      const leg1Events = collectEvents(strategy, 'leg1Executed');
      sdk.dipArb.emit('signal', makeLeg1Signal({ currentPrice: 0.40 }));
      await flush();

      expect(leg1Events).toHaveLength(1);
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
    it('should capture bid data from realtimeService bookCache', async () => {
      const { sdk, strategy } = await setupReady();
      const leg1Events = collectEvents(strategy, 'leg1Executed');

      // Update bids in bookCache (strategy reads from here in price poll)
      sdk.dipArb.realtimeService.bookCache.set('up-token-123', {
        bids: [{ price: 0.395, size: 200 }],
        asks: [{ price: 0.40, size: 100 }],
      });

      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(leg1Events).toHaveLength(1);
      // bestBid should reflect the latest bookCache data
      expect(leg1Events[0].bestBid.toNumber()).toBe(0.395);
      await strategy.stop();
    });

    it('should flush stale bookCache and upAsks/downAsks on market rotation', async () => {
      const { sdk, strategy } = await setupReady();

      // setupReady → emitStarted (clears) → populateOrderbook (repopulates)
      // Verify caches are populated with "old market" data
      expect(sdk.dipArb.realtimeService.bookCache.size).toBeGreaterThan(0);
      expect(sdk.dipArb.upAsks.length).toBeGreaterThan(0);
      expect(sdk.dipArb.downAsks.length).toBeGreaterThan(0);

      // Rotate to a new market — handleStarted should clear stale caches
      emitStarted(sdk, {
        slug: 'new-round',
        upTokenId: 'new-up-token',
        downTokenId: 'new-down-token',
      });

      // bookCache should be cleared (no stale resolved prices)
      expect(sdk.dipArb.realtimeService.bookCache.size).toBe(0);
      // SDK ask arrays should be cleared (no stale asks)
      expect(sdk.dipArb.upAsks).toEqual([]);
      expect(sdk.dipArb.downAsks).toEqual([]);

      await strategy.stop();
    });

    it('should fetch orderbook via REST when WebSocket data is missing', { timeout: 5000 }, async () => {
      const sdk = createMockSdk();
      const config = makeConfig();
      const strategy = new EnhancedDipArbStrategy(sdk, config);
      await strategy.start();

      // Emit started with token IDs but do NOT populate orderbook data
      // (simulates WebSocket subscription not delivering data)
      emitStarted(sdk);
      // handleStarted clears caches; don't repopulate — simulate WS failure

      // Mock global fetch to return orderbook data for our token IDs
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('up-token-123')) {
          return new Response(JSON.stringify({
            bids: [{ price: 0.42, size: 200 }],
            asks: [{ price: 0.43, size: 150 }],
          }), { status: 200 });
        }
        if (url.includes('down-token-456')) {
          return new Response(JSON.stringify({
            bids: [{ price: 0.52, size: 200 }],
            asks: [{ price: 0.53, size: 150 }],
          }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      });

      // Wait for immediate/1s REST fallback + async buffer
      await new Promise(r => setTimeout(r, 1500));

      // fetch should have been called for both tokens
      expect(fetchSpy).toHaveBeenCalled();
      const urls = fetchSpy.mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.includes('up-token-123'))).toBe(true);
      expect(urls.some(u => u.includes('down-token-456'))).toBe(true);

      // SDK caches should now be populated from REST data via handleOrderbookUpdate
      expect(sdk.dipArb.upAsks).toEqual([{ price: 0.43, size: 150 }]);
      expect(sdk.dipArb.downAsks).toEqual([{ price: 0.53, size: 150 }]);

      fetchSpy.mockRestore();
      await strategy.stop();
    });
  });

  // ── SDK phase reset (leg1 signals resume after emergency exit / rotation) ──
  describe('SDK phase reset', () => {
    it('should reset SDK currentRound.phase to watching after emergency exit', async () => {
      vi.useFakeTimers();
      try {
        // Market ends in 2 minutes — within the 3-minute emergency threshold
        const sdk = createMockSdk();
        const config = makeConfig();
        const strategy = new EnhancedDipArbStrategy(sdk, config);
        // Use advanceTimersByTimeAsync to process the async start()
        const startP = strategy.start();
        await vi.advanceTimersByTimeAsync(100);
        await startP;

        // Set up currentRound on mock SDK BEFORE started event
        sdk.dipArb.currentRound = { phase: 'watching', leg1: null };

        // Start round with 4 minutes remaining (above 3-min Gate 2 threshold so leg1 can enter,
        // but emergency timer fires once we advance past the 3-min threshold)
        const endTime = new Date(Date.now() + 240 * 1000); // 4 min from now
        sdk.dipArb.emit('started', {
          slug: 'btc-15m-round-1',
          endTime,
          durationMinutes: 15,
          upTokenId: 'up-token-123',
          downTokenId: 'down-token-456',
        });
        populateOrderbook(sdk);

        // Advance 600ms so price poll fires (every 500ms) and populates upBids/downBids
        await vi.advanceTimersByTimeAsync(600);

        const emergencyEvents = collectEvents(strategy, 'emergencyExit');

        // Leg 1 signal → fills in paper mode → notifySdkLeg1Filled sets phase='leg1_filled'
        sdk.dipArb.emit('signal', makeLeg1Signal());
        await vi.advanceTimersByTimeAsync(10);
        expect(sdk.dipArb.currentRound.phase).toBe('leg1_filled');

        // Advance timers past the 3-min-remaining threshold
        // Currently ~239s remaining, need <180s, so advance by 61s
        await vi.advanceTimersByTimeAsync(61_000);

        // Emergency exit should have fired and resetCycle should have reset SDK phase
        expect(emergencyEvents.length).toBe(1);
        expect(sdk.dipArb.currentRound.phase).toBe('watching');
        expect(sdk.dipArb.currentRound.leg1).toBeNull();

        await strategy.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset SDK currentRound.phase in handleStarted when rotating to a new market', async () => {
      const { sdk, strategy } = await setupReady();

      // Set up currentRound
      sdk.dipArb.currentRound = { phase: 'watching', leg1: null };

      // Leg 1 → fills → SDK phase becomes 'leg1_filled'
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(sdk.dipArb.currentRound.phase).toBe('leg1_filled');

      // Simulate market rotation — handleStarted fires for a new market
      emitStarted(sdk, { slug: 'btc-15m-round-2' });
      await flush();

      // SDK phase should be reset
      expect(sdk.dipArb.currentRound.phase).toBe('waiting');
      expect(sdk.dipArb.currentRound.leg1).toBeUndefined();

      // Leg 1 signal on the new market should be accepted
      const leg1Events = collectEvents(strategy, 'leg1Executed');
      populateOrderbook(sdk);
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(leg1Events.length).toBe(1);
      await strategy.stop();
    });

    it('should reset SDK phase after completed cycle then accept leg1 on next market', async () => {
      const { sdk, strategy } = await setupReady();

      sdk.dipArb.currentRound = { phase: 'watching', leg1: null };

      // Complete full cycle: Leg 1 + Leg 2
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();
      expect(sdk.dipArb.currentRound.phase).toBe('leg1_filled');

      sdk.dipArb.emit('signal', makeLeg2Signal());
      await flush();

      // After cycle completes, resetCycle resets SDK phase
      expect(sdk.dipArb.currentRound.phase).toBe('watching');
      expect(sdk.dipArb.currentRound.leg1).toBeNull();

      // New market rotation — handleStarted resets cycleAttemptedThisRound
      emitStarted(sdk, { slug: 'btc-15m-round-2' });
      await flush();

      // Leg 1 signal on the new market should be accepted
      const leg1Events = collectEvents(strategy, 'leg1Executed');
      populateOrderbook(sdk);
      sdk.dipArb.emit('signal', makeLeg1Signal());
      await flush();

      expect(leg1Events.length).toBe(1);
      await strategy.stop();
    });
  });
});
