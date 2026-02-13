import { EventEmitter } from 'node:events';
import Decimal from 'decimal.js';
import type { PolymarketSDK } from '@catalyst-team/poly-sdk';
import type { DipArbServiceConfig } from '@catalyst-team/poly-sdk';
import { isOrderFilled, isTerminalStatus } from '@catalyst-team/poly-sdk';
import { FeeAwareOrderPlacer } from './fee-aware-orders.js';
import { PositionSizer } from './position-sizer.js';
import type { BotConfig } from '../config.js';
import {
  Side,
  StrategyState,
  type LegInfo,
  type CycleResult,
  type StrategyStats,
  type PricePoint,
} from '../types/strategy.js';

// ── Events emitted by EnhancedDipArbStrategy ──────────────────────────
export interface EnhancedDipArbEvents {
  log: (entry: { message: string; timestamp: Date; level: string }) => void;
  stateChange: (state: StrategyState) => void;
  leg1Executed: (leg: LegInfo) => void;
  leg2Executed: (leg: LegInfo) => void;
  cycleComplete: (result: CycleResult) => void;
  emergencyExit: (info: { leg1: LegInfo; reason: string; sellPrice: Decimal }) => void;
  newRound: (info: { slug: string; secondsRemaining: number }) => void;
  priceUpdate: (info: {
    upAsk: number; upAskSize: number; upBid: number; upBidSize: number;
    downAsk: number; downAskSize: number; downBid: number; downBidSize: number;
    sum: number;
  }) => void;
  error: (err: Error) => void;
}

/**
 * Enhanced DipArb Strategy — wraps poly-sdk DipArbService.
 *
 * Layers on top of the base SDK:
 * 1. Fee-aware orders   — GTC limit orders to avoid 3.15% taker fee
 * 2. Emergency exit     — timeout + stop-loss for unhedged positions
 * 3. GTC fill tracking  — poll for fill confirmation before advancing state
 * 4. Early liquidation  — sell all positions before expiry to recycle capital
 */
export class EnhancedDipArbStrategy extends EventEmitter {
  private sdk: PolymarketSDK;
  private orderPlacer: FeeAwareOrderPlacer;
  private positionSizer: PositionSizer;
  private config: BotConfig;

  // Strategy state
  private state: StrategyState = StrategyState.WATCHING;
  private leg1: LegInfo | null = null;
  private leg2: LegInfo | null = null;
  private currentRound: string | null = null;
  private cycleAttemptedThisRound = false; // Only ONE entry per market
  private marketEndTimeMs = 0;             // Market end time for time-based exit
  private emergencyTimer: ReturnType<typeof setInterval> | null = null;

  // GTC fill tracking (Issues 1, 4, 9)
  private pendingLeg1OrderId: string | null = null;
  private pendingLeg2OrderId: string | null = null;
  private fillPollTimer: ReturnType<typeof setInterval> | null = null;
  private expectedOrderIds: Set<string> = new Set();

  // Exit sell order tracking ($0.99 GTC SELLs placed on fill)
  private leg1SellOrderId: string | null = null;
  private leg2SellOrderId: string | null = null;

  // Idempotency guard — both handleExecution and onGtcFilled can fire for same leg2 fill
  private cycleFinalized = false;

  // Continuous price feed for TUI (reads SDK orderbook state)
  private pricePollTimer: ReturnType<typeof setInterval> | null = null;
  private restPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollLogTime = 0;
  private pricePollTicks = 0;
  private restFetchInFlight = false;    // Prevent overlapping REST fetches
  private lastPriceHistoryLen = 0;      // Track SDK priceHistory growth to detect live WS
  private _lastSignalLogTime: Map<string, number> = new Map(); // Throttle signal debug logs

  // Bid data read from realtimeService.bookCache in price poll (SDK only stores asks internally)
  private upBids: Array<{ price: number; size: number }> = [];
  private downBids: Array<{ price: number; size: number }> = [];
  private currentUpTokenId: string | undefined;
  private currentDownTokenId: string | undefined;

  // Time tracking for TUI
  private lastSecondsRemaining = 900;

  // Price history for trend detection (sliding window)
  private upHistory: PricePoint[] = [];
  private downHistory: PricePoint[] = [];

  // Balance tracking (set externally by paper trader or live balance query)
  private currentBalance: number;

  // Stats
  private stats: StrategyStats = {
    cyclesCompleted: 0,
    cyclesAbandoned: 0,
    cyclesWon: 0,
    totalProfit: new Decimal(0),
    winRate: 0,
    emergencyExits: 0,
  };

  constructor(sdk: PolymarketSDK, config: BotConfig) {
    super();
    this.sdk = sdk;
    this.config = config;
    this.orderPlacer = new FeeAwareOrderPlacer(config.trading);
    this.currentBalance = config.paper.enabled ? config.paper.startingBalance : 1000;
    this.positionSizer = new PositionSizer(config.risk, this.currentBalance);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Configure the underlying DipArbService
    const dipConfig: Partial<DipArbServiceConfig> = {
      shares: this.config.trading.defaultShares,
      sumTarget: this.config.trading.defaultSumTarget,
      dipThreshold: this.config.trading.defaultDipThreshold,
      slidingWindowMs: this.config.trading.dumpWindowMs,
      windowMinutes: this.config.trading.windowMinutes,
      leg2TimeoutSeconds: 900, // We handle timeout ourselves via exitBeforeExpiryMinutes
      enableSurge: false, // Disabled: surge signals buy the opposite side at ceiling prices (e.g. UP@$0.97 when DOWN surges from $0.04→$0.05)
      autoMerge: true,
      autoExecute: false, // We control execution; explicit settlement in handleRoundComplete + autoSettle as fallback
      debug: false,
    };
    this.sdk.dipArb.updateConfig(dipConfig);

    // Wire up SDK events
    this.sdk.dipArb.on('signal', this.handleSignal.bind(this));
    this.sdk.dipArb.on('execution', this.handleExecution.bind(this));
    this.sdk.dipArb.on('roundComplete', this.handleRoundComplete.bind(this));
    this.sdk.dipArb.on('started', this.handleStarted.bind(this));
    this.sdk.dipArb.on('newRound', this.handleNewRound.bind(this));
    this.sdk.dipArb.on('error', this.handleError.bind(this));

    // Enable auto-rotation — settlement is always the fallback for unfilled sell orders
    const { assets, duration } = this.config.trading;
    const sdkUnderlyings = assets as ('BTC' | 'ETH' | 'SOL' | 'XRP')[];
    const sdkDuration = duration as '5m' | '15m';
    this.sdk.dipArb.enableAutoRotate({
      underlyings: sdkUnderlyings,
      duration: sdkDuration,
      autoSettle: true,
      settleStrategy: 'redeem',
      preloadMinutes: 2,
    });

    // Find and start a market — retry up to 3 times if none found
    let started = false;
    const activeMarket = await this.findCurrentlyActiveMarket(sdkUnderlyings[0], sdkDuration);
    if (activeMarket) {
      this.log('info', `Found active market: ${activeMarket.slug} (ends ${activeMarket.endTime.toLocaleTimeString()})`);
      await this.sdk.dipArb.start(activeMarket);
      started = true;
    } else {
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.log('warn', `No active market (attempt ${attempt}/3), trying findAndStart...`);
        try {
          const result = await this.sdk.dipArb.findAndStart({
            coin: sdkUnderlyings[0], preferDuration: sdkDuration,
          });
          if (result) { started = true; break; }
        } catch (err) {
          this.log('error', `findAndStart attempt ${attempt} failed: ${err}`);
        }
        if (attempt < 3) {
          this.log('info', 'Waiting 30s before retry...');
          await new Promise(r => setTimeout(r, 30000));
        }
      }
    }

    if (!started) {
      const msg = 'Failed to find any market after 3 attempts';
      this.log('error', msg);
      this.emit('error', new Error(msg));
    }

    this.log('info', `Enhanced DipArb started — ${assets.join('/')} ${duration}`);
  }

  async stop(): Promise<void> {
    this.clearEmergencyTimer();
    this.clearFillPollTimer();
    this.stopPricePoll();
    // Cancel any outstanding exit sell orders on stop
    if (!this.config.paper.enabled) {
      for (const orderId of [this.leg1SellOrderId, this.leg2SellOrderId]) {
        if (orderId) {
          try { await this.sdk.tradingService.cancelOrder(orderId); } catch {}
        }
      }
    }
    this.sdk.dipArb.stop();
    this.setState(StrategyState.WATCHING);
    this.log('info', 'Strategy stopped');
  }

  /**
   * Scan for the market whose time window contains the current time.
   * Prevents monitoring a resolved past market or an unstarted future market.
   */
  private async findCurrentlyActiveMarket(
    coin: 'BTC' | 'ETH' | 'SOL' | 'XRP',
    duration: '5m' | '15m',
  ): Promise<any | null> {
    try {
      const markets = await this.sdk.dipArb.scanUpcomingMarkets({
        coin,
        duration,
        minMinutesUntilEnd: 1,   // Include markets about to end
        maxMinutesUntilEnd: 60,
      });

      const now = Date.now();

      // Find market whose window contains current time: startTime <= now < endTime
      for (const m of markets) {
        const endMs = m.endTime.getTime();
        const durationMs = m.durationMinutes * 60 * 1000;
        const startMs = endMs - durationMs;
        if (startMs <= now && endMs > now) {
          return m;
        }
      }

      // No active market — return soonest upcoming one
      if (markets.length > 0) {
        this.log('info', `No active market found, ${markets.length} upcoming`);
        return markets[0];
      }

      return null;
    } catch (err) {
      this.log('error', `Market scan failed: ${err}`);
      return null;
    }
  }

  // ── SDK Event Handlers ───────────────────────────────────────────────

  /**
   * SDK 'started' — fires every time DipArbService starts monitoring a market.
   * This is the ONLY event that reliably fires on every market rotation.
   * The 'newRound' event may not fire for auto-rotated markets.
   */
  private handleStarted(event: any): void {
    const slug = event.slug ?? event.underlying ?? 'unknown';

    // Full state reset for the new market
    this.currentRound = slug;
    this.cycleAttemptedThisRound = false;
    this.upHistory = [];
    this.downHistory = [];
    this.expectedOrderIds.clear();
    this.clearEmergencyTimer();
    this.clearFillPollTimer();
    this.pendingLeg1OrderId = null;
    this.pendingLeg2OrderId = null;
    this.leg1SellOrderId = null;
    this.leg2SellOrderId = null;
    this.leg1 = null;
    this.leg2 = null;
    this.cycleFinalized = false;
    this.setState(StrategyState.WATCHING);

    // Calculate remaining time from market endTime (Date object)
    const endTimeMs = event.endTime instanceof Date
      ? event.endTime.getTime()
      : (typeof event.endTime === 'number' ? event.endTime : 0);
    const durationMs = (event.durationMinutes ?? 15) * 60 * 1000;
    this.marketEndTimeMs = endTimeMs > 0 ? endTimeMs : Date.now() + durationMs;
    const remaining = Math.max(0, Math.round((this.marketEndTimeMs - Date.now()) / 1000));
    this.lastSecondsRemaining = remaining;

    this.emit('newRound', { slug, secondsRemaining: remaining });

    // Store token IDs for reading bids from bookCache in the price poll.
    this.currentUpTokenId = event.upTokenId;
    this.currentDownTokenId = event.downTokenId;
    this.upBids = [];
    this.downBids = [];

    // Flush stale orderbook data left over from the previous market.
    // The SDK does NOT clear these caches on rotation — bookCache retains
    // resolved prices ($0.01/$0.99) and upAsks/downAsks keep old levels.
    const dipArb = this.sdk.dipArb as any;
    const realtimeService = dipArb?.realtimeService;
    if (realtimeService?.bookCache) {
      realtimeService.bookCache.clear();
    }
    if (dipArb) {
      dipArb.upAsks = [];
      dipArb.downAsks = [];
    }

    // Start/restart continuous price polling.
    // Bids are read from realtimeService.bookCache (populated by the SDK's own
    // subscription) — no separate orderbook subscription needed.
    this.startPricePoll();

    this.log('info', `New market: ${slug} — https://polymarket.com/event/${slug}`);
  }

  /**
   * SDK 'newRound' — fires when DipArbService creates a round within a market.
   * May not fire for auto-rotated markets. Carries upOpen/downOpen prices.
   */
  private handleNewRound(event: any): void {
    // Update round ID to the more specific per-round ID
    this.currentRound = event.roundId ?? this.currentRound;
    this.cycleAttemptedThisRound = false;
    this.upHistory = [];
    this.downHistory = [];
    this.expectedOrderIds.clear();

    // Always derive remaining time from marketEndTimeMs (set in handleStarted).
    // The SDK's newRound event may report a full-duration endTime that ignores
    // how far into the market we actually are.
    const remaining = this.marketEndTimeMs > 0
      ? Math.max(0, Math.round((this.marketEndTimeMs - Date.now()) / 1000))
      : this.lastSecondsRemaining;
    this.lastSecondsRemaining = remaining;

    this.emit('newRound', { slug: this.currentRound, secondsRemaining: remaining });

    // Seed initial prices from round data
    const upOpen = Number(event.upOpen) || 0;
    const downOpen = Number(event.downOpen) || 0;
    if (upOpen > 0 || downOpen > 0) {
      const now = Date.now();
      if (upOpen > 0) this.upHistory.push({ price: new Decimal(upOpen), timestamp: now });
      if (downOpen > 0) this.downHistory.push({ price: new Decimal(downOpen), timestamp: now });
      this.emit('priceUpdate', {
        upAsk: upOpen, upAskSize: 0, upBid: 0, upBidSize: 0,
        downAsk: downOpen, downAskSize: 0, downBid: 0, downBidSize: 0,
        sum: upOpen + downOpen,
      });
    }

    this.log('info', `Round started: ${this.currentRound} (${remaining}s remaining)`);
  }

  /**
   * Core signal handler — intercepts every dip/surge signal from the SDK
   * and applies our filters + fee-aware ordering BEFORE execution.
   */
  private async handleSignal(signal: any): Promise<void> {
    // Track price history for trend detection
    this.recordPrice(signal);

    // Track seconds remaining for TUI
    const secondsRemaining = signal.secondsRemaining as number | undefined;
    if (secondsRemaining != null) {
      this.lastSecondsRemaining = secondsRemaining;
    }

    // Log every signal received from the SDK (throttled: once per 30s per type)
    const sigKey = `${signal.type}_${signal.source ?? 'dip'}`;
    const now = Date.now();
    if (!this._lastSignalLogTime) this._lastSignalLogTime = new Map();
    const lastLog = this._lastSignalLogTime.get(sigKey) ?? 0;
    if (now - lastLog > 30_000) {
      this._lastSignalLogTime.set(sigKey, now);
      this.log('debug',
        `SIGNAL: type=${signal.type} source=${signal.source ?? 'dip'} ` +
        `side=${signal.dipSide} price=$${Number(signal.currentPrice).toFixed(4)} ` +
        `drop=${((signal.dropPercent ?? 0) * 100).toFixed(1)}% state=${this.state}`,
      );
    }

    // Only handle Leg 1 signals when we're watching
    if (signal.type === 'leg1') {
      await this.handleLeg1Signal(signal);
    } else if (signal.type === 'leg2') {
      await this.handleLeg2Signal(signal);
    }
  }

  private async handleLeg1Signal(signal: any): Promise<void> {
    if (this.state !== StrategyState.WATCHING) {
      return; // Already in a cycle (including LEG1_PENDING, LEG2_PENDING, LIQUIDATING)
    }

    // ── Gate 1: One entry per market ─────────────────────────────────
    if (this.cycleAttemptedThisRound) {
      return; // Already entered (or exited) this market — no re-entry
    }

    // ── Gate 2: Time remaining — don't enter near expiry ───────────
    // The SDK's windowMinutes filter can misfire when joining a market
    // mid-way. Our own marketEndTimeMs (from the started event) is the
    // source of truth. Never enter if we'd immediately emergency exit.
    {
      const secsLeft = Math.max(0, Math.round((this.marketEndTimeMs - Date.now()) / 1000));
      const minRequired = this.config.risk.exitBeforeExpiryMinutes * 60;
      if (secsLeft <= minRequired) {
        this.log('debug', `GATE 2 REJECT: ${secsLeft}s left < ${minRequired}s required`);
        return;
      }
    }

    // ── Gate 3: Extract signal data ─────────────────────────────────
    const side: Side = signal.dipSide === 'UP' ? Side.UP : Side.DOWN;
    const currentPrice = new Decimal(signal.currentPrice);
    const oppositeAsk = new Decimal(signal.oppositeAsk);
    const dropPct = signal.dropPercent;
    const signalSource: string = signal.source ?? 'dip'; // 'dip' | 'surge' | 'mispricing'

    // ── Gate 4: Reject non-dip signals ───────────────────────────
    // Surge/mispricing signals can fire with absurd parameters (e.g. buy UP@$0.97
    // because DOWN surged 25% from $0.04→$0.05). The dropPercent field is overloaded
    // and doesn't represent an actual dip of the buying side.
    if (signalSource !== 'dip') {
      this.log('debug', `GATE 4 REJECT: source=${signalSource} (only 'dip' accepted)`);
      return;
    }

    // ── Gate 5: Circuit breaker ────────────────────────────────────
    if (this.positionSizer.isTradingPaused()) {
      const reason = this.positionSizer.getPauseReason();
      this.log('warn', `CIRCUIT BREAKER: ${reason}`);
      return;
    }

    // ── Gate 6: Position sizing ────────────────────────────────────
    const shares = this.positionSizer.calculateShares(
      this.currentBalance,
      currentPrice.toNumber(),
    );
    if (shares === 0) {
      this.log('warn', `Position sizer returned 0 shares (balance=$${this.currentBalance.toFixed(2)})`);
      return;
    }

    // ── Gate 7: Fee-aware order type ────────────────────────────────
    const orderType = this.orderPlacer.decideLeg1OrderType(
      currentPrice.toNumber(),
      oppositeAsk.toNumber(),
      this.config.trading.defaultSumTarget,
    );

    this.log(
      'info',
      `LEG 1 SIGNAL: ${side} dipped ${(dropPct * 100).toFixed(1)}% → ` +
      `price=$${currentPrice.toFixed(4)}, opposite=$${oppositeAsk.toFixed(4)}, ` +
      `sum=$${currentPrice.plus(oppositeAsk).toFixed(4)}, ` +
      `shares=${shares} (${(this.config.risk.maxBalancePctPerTrade * 100).toFixed(0)}% of $${this.currentBalance.toFixed(0)}), ` +
      `order=${orderType}`,
    );

    // ── Execute Leg 1 ───────────────────────────────────────────────
    this.cycleAttemptedThisRound = true; // Lock out re-entry for this market
    try {
      if (this.config.paper.enabled) {
        // Paper mode — emit for paper trader to handle
        // Use real orderbook data for paper LegInfo (for accurate slippage simulation)
        const leg1Bids = this.getBids(side);
        const leg1DipArb = this.sdk.dipArb as any;
        const leg1Asks = side === Side.UP ? leg1DipArb.upAsks : leg1DipArb.downAsks;
        const paperBid = leg1Bids[0]?.price ?? 0;
        const paperAsk = leg1Asks?.[0]?.price ? Number(leg1Asks[0].price) : 0;

        const leg: LegInfo = {
          side,
          price: currentPrice,
          shares: new Decimal(shares),
          tokenId: signal.tokenId,
          timestamp: new Date(),
          orderType,
          bestBid: paperBid > 0 ? new Decimal(paperBid) : undefined,
          bestAsk: paperAsk > 0 ? new Decimal(paperAsk) : undefined,
        };
        this.leg1 = leg;
        this.setState(StrategyState.WAITING_FOR_HEDGE);
        this.notifySdkLeg1Filled(leg);
        this.startEmergencyTimer();
        this.emit('leg1Executed', leg);
        this.log('info', `LEG 1 FILLED (paper): ${leg.shares} ${side} @ $${leg.price.toFixed(4)} [${orderType}]`);
        await this.placeExitSell(leg, 1);
      } else {
        await this.executeLeg1Live(signal, orderType);
      }
    } catch (err) {
      this.log('error', `Leg 1 execution failed: ${err}`);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async handleLeg2Signal(signal: any): Promise<void> {
    if (this.state !== StrategyState.WAITING_FOR_HEDGE || !this.leg1) {
      return;
    }

    const oppositeAsk = new Decimal(signal.currentPrice);
    const leg1Price = this.leg1.price;
    const sumTarget = this.config.trading.defaultSumTarget;

    const sum = leg1Price.plus(oppositeAsk);
    if (sum.greaterThan(new Decimal(sumTarget))) {
      return; // Not profitable enough yet
    }

    // Leg 2 is always GTC (maker)
    const orderType = this.orderPlacer.decideLeg2OrderType();
    const hedgeSide = this.leg1.side === Side.UP ? Side.DOWN : Side.UP;

    this.log(
      'info',
      `LEG 2 SIGNAL: ${hedgeSide} @ $${oppositeAsk.toFixed(4)} ` +
      `(sum=$${sum.toFixed(4)}, target=${sumTarget.toFixed(4)}) [${orderType}]`,
    );

    try {
      if (this.config.paper.enabled) {
        // Use real orderbook data for paper LegInfo (for accurate slippage simulation)
        const hedgeBids = this.getBids(hedgeSide);
        const hedgeDipArb = this.sdk.dipArb as any;
        const hedgeAsks = hedgeSide === Side.UP ? hedgeDipArb.upAsks : hedgeDipArb.downAsks;
        const hedgeBid = hedgeBids[0]?.price ?? 0;
        const hedgeAsk = hedgeAsks?.[0]?.price ? Number(hedgeAsks[0].price) : 0;

        const leg2: LegInfo = {
          side: hedgeSide,
          price: oppositeAsk,
          shares: this.leg1.shares,
          tokenId: signal.tokenId,
          timestamp: new Date(),
          orderType,
          bestBid: hedgeBid > 0 ? new Decimal(hedgeBid) : undefined,
          bestAsk: hedgeAsk > 0 ? new Decimal(hedgeAsk) : undefined,
        };
        this.clearEmergencyTimer();
        this.leg2 = leg2;
        this.setState(StrategyState.COMPLETED);
        this.emit('leg2Executed', leg2);

        const totalCost = this.leg1.price.times(this.leg1.shares)
          .plus(leg2.price.times(leg2.shares));
        const payout = this.leg1.shares; // $1 per share pair
        const profit = payout.minus(totalCost);

        const result: CycleResult = {
          roundSlug: this.currentRound ?? 'unknown',
          leg1: this.leg1,
          leg2,
          totalCost,
          payout,
          profit,
          profitPct: profit.dividedBy(totalCost),
          status: 'completed',
          completedAt: new Date(),
        };

        this.stats.cyclesCompleted++;
        if (profit.greaterThan(0)) {
          this.stats.cyclesWon++;
        }
        this.stats.totalProfit = this.stats.totalProfit.plus(profit);
        this.positionSizer.recordResult(profit.toNumber());
        this.updateWinRate();

        this.log('info',
          `CYCLE COMPLETE: cost=$${totalCost.toFixed(4)}, ` +
          `profit=$${profit.toFixed(4)} (${result.profitPct.times(100).toFixed(2)}%)`,
        );

        this.emit('cycleComplete', result);
        await this.placeExitSell(leg2, 2);
        await this.resetCycle();
      } else {
        await this.executeLeg2Live(signal, orderType);
      }
    } catch (err) {
      this.log('error', `Leg 2 execution failed: ${err}`);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Handle SDK execution events (live trading fills from the exchange).
   * Guards against stale executions from previous rounds via expectedOrderIds.
   * Both this handler and onGtcFilled can fire for the same fill —
   * finalizeLiveCycle's idempotency guard prevents double processing.
   */
  private handleExecution(result: any): void {
    this.log('info', `SDK Execution: leg=${result.leg} success=${result.success} shares=${result.shares}`);

    // Only accept executions for orders we are tracking (prevents stale fills from previous rounds)
    const resultOrderId = result.orderId ?? result.id;
    if (resultOrderId && !this.expectedOrderIds.has(resultOrderId)) {
      this.log('warn', `Ignoring stale execution for unknown order ${resultOrderId}`);
      return;
    }

    if (result.leg === 'leg1' && result.success) {
      if (this.state !== StrategyState.LEG1_PENDING && this.state !== StrategyState.WATCHING) {
        this.log('warn', `Ignoring leg1 execution in state ${this.state}`);
        return;
      }
      const leg: LegInfo = {
        side: result.side === 'UP' ? Side.UP : Side.DOWN,
        price: new Decimal(result.price),
        shares: new Decimal(result.shares),
        tokenId: result.tokenId ?? '',
        timestamp: new Date(),
        orderType: 'GTC',
        orderId: resultOrderId,
      };
      this.leg1 = leg;
      this.setState(StrategyState.WAITING_FOR_HEDGE);
      this.notifySdkLeg1Filled(leg);
      this.startEmergencyTimer();
      this.emit('leg1Executed', leg);
    }

    if (result.leg === 'leg2' && result.success) {
      if (this.state !== StrategyState.LEG2_PENDING && this.state !== StrategyState.WAITING_FOR_HEDGE) {
        this.log('warn', `Ignoring leg2 execution in state ${this.state}`);
        return;
      }
      this.clearEmergencyTimer();
      const leg2: LegInfo = {
        side: result.side === 'UP' ? Side.UP : Side.DOWN,
        price: new Decimal(result.price),
        shares: new Decimal(result.shares),
        tokenId: result.tokenId ?? '',
        timestamp: new Date(),
        orderType: 'GTC',
        orderId: resultOrderId,
      };
      this.leg2 = leg2;
      this.setState(StrategyState.COMPLETED);
      this.emit('leg2Executed', leg2);
      this.finalizeLiveCycle(leg2);
      this.placeExitSell(leg2, 2).then(() => this.resetCycle()).catch(err => {
        this.log('error', `Exit sell/reset failed: ${err}`);
      });
    }
  }

  /**
   * Finalize a live cycle after leg2 fills — calculate P&L, update stats, emit cycleComplete.
   * Idempotent: both handleExecution() and onGtcFilled() may fire for the same fill.
   */
  private finalizeLiveCycle(leg2Info: LegInfo): void {
    if (this.cycleFinalized || !this.leg1) return;
    this.cycleFinalized = true;

    const totalCost = this.leg1.price.times(this.leg1.shares)
      .plus(leg2Info.price.times(leg2Info.shares));
    const payout = this.leg1.shares; // $1 per share pair
    const profit = payout.minus(totalCost);

    const result: CycleResult = {
      roundSlug: this.currentRound ?? 'unknown',
      leg1: this.leg1,
      leg2: leg2Info,
      totalCost,
      payout,
      profit,
      profitPct: totalCost.isZero() ? new Decimal(0) : profit.dividedBy(totalCost),
      status: 'completed',
      completedAt: new Date(),
    };

    this.stats.cyclesCompleted++;
    if (profit.greaterThan(0)) this.stats.cyclesWon++;
    this.stats.totalProfit = this.stats.totalProfit.plus(profit);
    this.positionSizer.recordResult(profit.toNumber());
    this.updateWinRate();

    this.log('info',
      `CYCLE COMPLETE (live): cost=$${totalCost.toFixed(4)}, profit=$${profit.toFixed(4)} (${result.profitPct.times(100).toFixed(2)}%)`,
    );
    this.emit('cycleComplete', result);
  }

  private async handleRoundComplete(result: any): Promise<void> {
    const profit = new Decimal(result.profit ?? 0);
    if (result.status === 'completed') {
      this.stats.cyclesCompleted++;
      if (profit.greaterThan(0)) {
        this.stats.cyclesWon++;
      }
      this.stats.totalProfit = this.stats.totalProfit.plus(profit);
      this.log('info', `Round complete: profit=$${profit.toFixed(4)}`);
    } else {
      this.stats.cyclesAbandoned++;
      this.log('warn', `Round abandoned: status=${result.status}`);
    }
    this.updateWinRate();

    // Explicitly settle any positions that weren't sold via $0.99 exit sells
    // (e.g., losing side never reaches $0.99). autoSettle is a fallback but
    // may not run at the right time with autoExecute: false.
    if (!this.config.paper.enabled) {
      try {
        const settleResult = await this.sdk.dipArb.settle('redeem');
        if (settleResult.success) {
          this.log('info', `Settlement: redeemed ${settleResult.amountReceived ?? 0} USDC (tx=${settleResult.txHash ?? 'n/a'})`);
        }
      } catch (err) {
        this.log('warn', `Settlement attempt failed: ${err} (autoSettle fallback will retry)`);
      }
    }

    await this.resetCycle();
  }

  private handleError(err: Error): void {
    this.log('error', `SDK error: ${err.message}`);
    this.emit('error', err);
  }

  // ── Live Execution Helpers ───────────────────────────────────────────

  private async executeLeg1Live(signal: any, orderType: 'GTC' | 'FOK'): Promise<boolean> {
    const tokenId = signal.tokenId;
    const price = signal.targetPrice ?? signal.currentPrice;
    const shares = this.positionSizer.calculateShares(this.currentBalance, price);
    if (shares === 0) return false;

    const side: Side = signal.dipSide === 'UP' ? Side.UP : Side.DOWN;

    // Use real orderbook bid/ask from bookCache
    const bids = this.getBids(side);
    const dipArb = this.sdk.dipArb as any;
    const asks = side === Side.UP ? dipArb.upAsks : dipArb.downAsks;
    const bestBid = signal.bestBid ?? bids[0]?.price ?? 0;
    const bestAsk = signal.bestAsk ?? (asks?.[0]?.price ? Number(asks[0].price) : price);

    if (orderType === 'GTC') {
      // Place a limit buy at the ask price (to get filled)
      const limitPrice = bestAsk > 0 ? bestAsk : price;
      const order = await this.sdk.tradingService.createLimitOrder({
        tokenId,
        side: 'BUY',
        price: limitPrice,
        size: shares,
        orderType: 'GTC',
      });

      const orderId = order.orderId ?? null;
      if (!orderId) {
        this.log('error', 'Leg 1 GTC placed but no orderId returned');
        return false;
      }

      this.pendingLeg1OrderId = orderId;
      this.expectedOrderIds.add(orderId);
      this.setState(StrategyState.LEG1_PENDING);
      this.log('info', `Leg 1 GTC limit placed: ${orderId}, polling for fill...`);

      // Start polling for fill confirmation
      this.startFillPolling('leg1', orderId, {
        side,
        price: limitPrice,
        shares,
        tokenId,
        bestBid,
        bestAsk,
      });
      return true;

    } else {
      // FOK market order — fills immediately or fails
      const order = await this.sdk.tradingService.createMarketOrder({
        tokenId,
        side: 'BUY',
        amount: shares * price,
        orderType: 'FOK',
      });

      if (!order.success) {
        this.log('error', `Leg 1 FOK failed: ${order.errorMsg ?? 'unknown error'}`);
        // cycleAttemptedThisRound stays true — no re-entry this market
        return false;
      }

      this.log('info', `Leg 1 FOK executed: ${order.orderId ?? 'ok'}`);

      const leg: LegInfo = {
        side,
        price: new Decimal(price),
        shares: new Decimal(shares),
        tokenId,
        timestamp: new Date(),
        orderType: 'FOK',
        bestBid: bestBid > 0 ? new Decimal(bestBid) : undefined,
        bestAsk: bestAsk > 0 ? new Decimal(bestAsk) : undefined,
      };
      this.leg1 = leg;
      this.setState(StrategyState.WAITING_FOR_HEDGE);
      this.notifySdkLeg1Filled(leg);
      this.startEmergencyTimer();
      this.emit('leg1Executed', leg);
      await this.placeExitSell(leg, 1);
      return true;
    }
  }

  private async executeLeg2Live(signal: any, _orderType: 'GTC' | 'FOK'): Promise<void> {
    const tokenId = signal.tokenId;
    const shares = this.leg1?.shares.toNumber() ?? this.config.trading.defaultShares;
    const price = signal.currentPrice;

    // Use real orderbook data for the hedge side
    const hedgeSide = this.leg1!.side === Side.UP ? Side.DOWN : Side.UP;
    const bids = this.getBids(hedgeSide);
    const dipArb = this.sdk.dipArb as any;
    const asks = hedgeSide === Side.UP ? dipArb.upAsks : dipArb.downAsks;
    const bestBid = signal.bestBid ?? bids[0]?.price ?? 0;
    const bestAsk = signal.bestAsk ?? (asks?.[0]?.price ? Number(asks[0].price) : price);

    // Place limit buy at the ask price to get filled
    const limitPrice = bestAsk > 0 ? bestAsk : price;

    const order = await this.sdk.tradingService.createLimitOrder({
      tokenId,
      side: 'BUY',
      price: limitPrice,
      size: shares,
      orderType: 'GTC',
    });

    const orderId = order.orderId ?? null;
    if (!orderId) {
      this.log('error', 'Leg 2 GTC placed but no orderId returned');
      return;
    }

    this.pendingLeg2OrderId = orderId;
    this.expectedOrderIds.add(orderId);
    // Issue 4: DO NOT clear emergency timer — it stays active until fill confirmed
    this.setState(StrategyState.LEG2_PENDING);
    this.log('info', `Leg 2 GTC limit placed @ $${limitPrice.toFixed(4)}, orderId=${orderId}, polling...`);

    // Poll for fill — onGtcFilled will clear the emergency timer on confirmed fill
    this.startFillPolling('leg2', orderId, {
      side: hedgeSide,
      price: limitPrice,
      shares,
      tokenId,
      bestBid,
      bestAsk,
    });
  }

  // ── GTC Fill Polling ────────────────────────────────────────────────
  //
  // Polls getOrder(orderId) to detect fills for GTC limit orders.
  // Three outcomes per poll:
  //   1. Order status is 'filled'     → call onGtcFilled (success path)
  //   2. Order is terminal but NOT filled (cancelled/expired/rejected)
  //      → check filledSize for partial fills, or reset/emergency exit
  //   3. Order is still active (pending/open/partially_filled)
  //      → check timeout, cancel if exceeded
  //
  // Why not getOpenOrders()? An order disappearing from the list could
  // mean filled, cancelled, expired, or rejected. getOrder() gives the
  // explicit status so we can handle each case correctly.

  private startFillPolling(
    leg: 'leg1' | 'leg2',
    orderId: string,
    orderDetails: {
      side: Side;
      price: number;
      shares: number;
      tokenId: string;
      bestBid?: number;
      bestAsk?: number;
    },
  ): void {
    const timeoutMs = this.config.trading.gtcFillTimeoutMs;
    const pollMs = this.config.trading.gtcPollIntervalMs;
    const startTime = Date.now();

    this.clearFillPollTimer();

    this.fillPollTimer = setInterval(async () => {
      try {
        // Use getOrder() for explicit status check instead of getOpenOrders()
        const order = await this.sdk.tradingService.getOrder(orderId);

        if (!order) {
          // Order not found — may have been cancelled externally
          this.log('warn', `GTC ${leg} order ${orderId} not found — may have been cancelled externally`);
          this.clearFillPollTimer();
          this.expectedOrderIds.delete(orderId);
          if (leg === 'leg1') {
            this.pendingLeg1OrderId = null;
            await this.resetCycle();
          } else {
            this.pendingLeg2OrderId = null;
            await this.performEmergencyExit('Leg 2 order disappeared');
          }
          return;
        }

        const status = order.status;

        if (isOrderFilled(status)) {
          this.clearFillPollTimer();
          this.onGtcFilled(leg, orderId, orderDetails);
          return;
        }

        if (isTerminalStatus(status) && !isOrderFilled(status)) {
          // CANCELLED, EXPIRED, REJECTED — but may have partial fills
          this.clearFillPollTimer();
          const filledSize = Number((order as any).filledSize ?? (order as any).size_matched ?? 0);
          this.log('warn', `GTC ${leg} order ${orderId} terminal: ${status}, filledSize=${filledSize}`);
          this.expectedOrderIds.delete(orderId);

          if (filledSize > 0) {
            // Partial fill — treat as filled with actual filled quantity
            this.log('info', `GTC ${leg} partial fill: ${filledSize}/${orderDetails.shares} shares`);
            this.onGtcFilled(leg, orderId, { ...orderDetails, shares: filledSize });
            return;
          }

          // Zero fill — truly failed
          if (leg === 'leg1') {
            this.pendingLeg1OrderId = null;
            await this.resetCycle();
          } else {
            this.pendingLeg2OrderId = null;
            await this.performEmergencyExit(`Leg 2 order ${status}`);
          }
          return;
        }

        // Still active (PENDING, OPEN, PARTIALLY_FILLED) — check timeout
        if (Date.now() - startTime > timeoutMs) {
          this.clearFillPollTimer();
          this.log('warn', `GTC ${leg} order ${orderId} timed out after ${timeoutMs}ms, cancelling`);
          try {
            await this.sdk.tradingService.cancelOrder(orderId);
          } catch {
            this.log('error', `Failed to cancel timed-out ${leg} order`);
          }
          this.expectedOrderIds.delete(orderId);

          if (leg === 'leg1') {
            this.pendingLeg1OrderId = null;
            await this.resetCycle();
          } else {
            this.pendingLeg2OrderId = null;
            await this.performEmergencyExit('Leg 2 GTC fill timeout');
          }
        }
      } catch (err) {
        this.log('error', `Fill poll error: ${err}`);
      }
    }, pollMs);
  }

  private onGtcFilled(
    leg: 'leg1' | 'leg2',
    orderId: string,
    details: {
      side: Side;
      price: number;
      shares: number;
      tokenId: string;
      bestBid?: number;
      bestAsk?: number;
    },
  ): void {
    this.log('info', `GTC ${leg} order ${orderId} FILLED`);

    if (leg === 'leg1') {
      this.pendingLeg1OrderId = null;
      const legInfo: LegInfo = {
        side: details.side,
        price: new Decimal(details.price),
        shares: new Decimal(details.shares),
        tokenId: details.tokenId,
        timestamp: new Date(),
        orderType: 'GTC',
        orderId,
        bestBid: details.bestBid != null ? new Decimal(details.bestBid) : undefined,
        bestAsk: details.bestAsk != null ? new Decimal(details.bestAsk) : undefined,
      };
      this.leg1 = legInfo;
      this.setState(StrategyState.WAITING_FOR_HEDGE);
      this.notifySdkLeg1Filled(legInfo);
      this.startEmergencyTimer();
      this.emit('leg1Executed', legInfo);
      this.placeExitSell(legInfo, 1).catch(err => {
        this.log('error', `Exit sell for leg1 failed: ${err}`);
      });
    } else {
      // Leg 2 filled — NOW clear emergency timer (Issue 4)
      this.pendingLeg2OrderId = null;
      this.clearEmergencyTimer();
      this.setState(StrategyState.COMPLETED);
      const leg2Info: LegInfo = {
        side: details.side,
        price: new Decimal(details.price),
        shares: new Decimal(details.shares),
        tokenId: details.tokenId,
        timestamp: new Date(),
        orderType: 'GTC',
        orderId,
      };
      this.leg2 = leg2Info;
      this.emit('leg2Executed', leg2Info);
      this.finalizeLiveCycle(leg2Info);
      this.placeExitSell(leg2Info, 2).then(() => this.resetCycle()).catch(err => {
        this.log('error', `Exit sell/reset for leg2 failed: ${err}`);
      });
    }
  }

  private clearFillPollTimer(): void {
    if (this.fillPollTimer) {
      clearInterval(this.fillPollTimer);
      this.fillPollTimer = null;
    }
  }

  // ── Continuous Price Feed ─────────────────────────────────────────────

  /**
   * Read bids for a token from realtimeService.bookCache and update local cache.
   * Falls back to this.upBids/downBids if bookCache unavailable.
   */
  private getBids(side: Side): Array<{ price: number; size: number }> {
    const dipArb = this.sdk.dipArb as any;
    const realtimeService = dipArb?.realtimeService;
    const tokenId = side === Side.UP ? this.currentUpTokenId : this.currentDownTokenId;

    if (realtimeService && tokenId) {
      const book = realtimeService.getBook?.(tokenId) ?? realtimeService.bookCache?.get(tokenId);
      if (book?.bids?.length > 0) {
        const bids = book.bids.map((l: any) => ({ price: Number(l.price), size: Number(l.size) }));
        if (side === Side.UP) this.upBids = bids; else this.downBids = bids;
        return bids;
      }
    }
    return side === Side.UP ? this.upBids : this.downBids;
  }

  /**
   * Poll SDK's internal orderbook state every 500ms and emit priceUpdate
   * events for the TUI. Reads all data from the SDK's own caches —
   * asks from dipArb.upAsks/downAsks, bids from realtimeService.bookCache.
   */
  private startPricePoll(): void {
    this.stopPricePoll();
    this.pricePollTicks = 0;
    this.lastPollLogTime = Date.now();
    this.lastPriceHistoryLen = (this.sdk.dipArb as any).priceHistory?.length ?? 0;

    // Main price poll — reads from SDK caches every 500ms
    this.pricePollTimer = setInterval(() => {
      const dipArb = this.sdk.dipArb as any;
      const realtimeService = dipArb?.realtimeService;
      const now = Date.now();

      // Read asks from SDK (primary: priceHistory, fallback: upAsks/downAsks)
      const sdkHistory = dipArb.priceHistory as Array<{ timestamp: number; upAsk: number; downAsk: number }> | undefined;
      let upAsk = 0;
      let downAsk = 0;

      if (sdkHistory && sdkHistory.length > 0) {
        const latest = sdkHistory[sdkHistory.length - 1];
        upAsk = latest.upAsk;
        downAsk = latest.downAsk;
      } else {
        upAsk = Number(dipArb.upAsks?.[0]?.price) || 0;
        downAsk = Number(dipArb.downAsks?.[0]?.price) || 0;
      }

      // Read sizes from SDK's direct ask arrays
      const upAskSize = Number(dipArb.upAsks?.[0]?.size) || 0;
      const downAskSize = Number(dipArb.downAsks?.[0]?.size) || 0;

      // Read bids from realtimeService.bookCache (populated by SDK's own subscription).
      // This avoids needing a separate WebSocket subscription for bid data.
      let upBid = 0, upBidSize = 0, downBid = 0, downBidSize = 0;
      if (realtimeService && this.currentUpTokenId && this.currentDownTokenId) {
        const upBook = realtimeService.getBook?.(this.currentUpTokenId)
                    ?? realtimeService.bookCache?.get(this.currentUpTokenId);
        const downBook = realtimeService.getBook?.(this.currentDownTokenId)
                      ?? realtimeService.bookCache?.get(this.currentDownTokenId);
        if (upBook?.bids?.[0]) {
          upBid = Number(upBook.bids[0].price) || 0;
          upBidSize = Number(upBook.bids[0].size) || 0;
          this.upBids = upBook.bids.map((l: any) => ({ price: Number(l.price), size: Number(l.size) }));
        }
        if (downBook?.bids?.[0]) {
          downBid = Number(downBook.bids[0].price) || 0;
          downBidSize = Number(downBook.bids[0].size) || 0;
          this.downBids = downBook.bids.map((l: any) => ({ price: Number(l.price), size: Number(l.size) }));
        }
      }

      this.pricePollTicks++;

      // Both sides must have ask data
      if (upAsk <= 0 || downAsk <= 0) return;

      // Binary option sanity check: UP + DOWN should be ~$1.00
      const sum = upAsk + downAsk;
      if (sum < 0.50 || sum > 1.50) return;

      // Record into price history
      const lastUp = this.upHistory.at(-1);
      if (!lastUp || !lastUp.price.eq(upAsk)) {
        this.upHistory.push({ price: new Decimal(upAsk), timestamp: now });
      }
      const lastDown = this.downHistory.at(-1);
      if (!lastDown || !lastDown.price.eq(downAsk)) {
        this.downHistory.push({ price: new Decimal(downAsk), timestamp: now });
      }

      // Trim old history (5 min window)
      const cutoff = now - 5 * 60 * 1000;
      this.upHistory = this.upHistory.filter(p => p.timestamp >= cutoff);
      this.downHistory = this.downHistory.filter(p => p.timestamp >= cutoff);

      // Emit full orderbook data for TUI
      this.emit('priceUpdate', {
        upAsk, upAskSize, upBid, upBidSize,
        downAsk, downAskSize, downBid, downBidSize,
        sum,
      });
    }, 500);

    // REST fallback poll — runs every 5s, checks if WebSocket is alive.
    // The SDK appends to dipArb.priceHistory on every WebSocket orderbook
    // message. If priceHistory isn't growing, WebSocket is dead and we
    // fetch via REST to keep prices updating.
    this.restPollTimer = setInterval(() => {
      const dipArb = this.sdk.dipArb as any;
      const currentLen = dipArb.priceHistory?.length ?? 0;
      if (currentLen > this.lastPriceHistoryLen) {
        // WebSocket is alive — priceHistory is growing
        this.lastPriceHistoryLen = currentLen;
        return;
      }
      this.lastPriceHistoryLen = currentLen;
      this.fetchOrderbookRest();
    }, 5000);
  }

  private stopPricePoll(): void {
    if (this.pricePollTimer) {
      clearInterval(this.pricePollTimer);
      this.pricePollTimer = null;
    }
    if (this.restPollTimer) {
      clearInterval(this.restPollTimer);
      this.restPollTimer = null;
    }
  }

  /**
   * REST fallback — fetch orderbook via CLOB REST API when WebSocket
   * subscription fails to deliver data after market rotation.
   *
   * Injects data into the SDK's signal pipeline via handleOrderbookUpdate()
   * so dip detection works even when WebSocket is dead. Also updates
   * bookCache for bid display in the TUI price poll.
   */
  private async fetchOrderbookRest(): Promise<void> {
    if (this.restFetchInFlight) return;
    if (!this.currentUpTokenId || !this.currentDownTokenId) return;

    this.restFetchInFlight = true;
    try {
      const marketsService = (this.sdk as any).markets;
      if (!marketsService?.getTokenOrderbook) return;

      const [upBook, downBook] = await Promise.all([
        marketsService.getTokenOrderbook(this.currentUpTokenId).catch(() => null),
        marketsService.getTokenOrderbook(this.currentDownTokenId).catch(() => null),
      ]);

      const dipArb = this.sdk.dipArb as any;
      const realtimeService = dipArb?.realtimeService;

      // Inject REST data through the SDK's full signal pipeline:
      // handleOrderbookUpdate(book) → updates asks → records priceHistory → detectSignal()
      // This is the same path that WebSocket data takes, enabling dip detection via REST.
      if (upBook?.asks?.length) {
        if (typeof dipArb.handleOrderbookUpdate === 'function') {
          dipArb.handleOrderbookUpdate({ tokenId: this.currentUpTokenId, ...upBook });
        } else {
          dipArb.upAsks = upBook.asks;
        }
        if (realtimeService?.bookCache) {
          realtimeService.bookCache.set(this.currentUpTokenId, upBook);
        }
      }
      if (downBook?.asks?.length) {
        if (typeof dipArb.handleOrderbookUpdate === 'function') {
          dipArb.handleOrderbookUpdate({ tokenId: this.currentDownTokenId, ...downBook });
        } else {
          dipArb.downAsks = downBook.asks;
        }
        if (realtimeService?.bookCache) {
          realtimeService.bookCache.set(this.currentDownTokenId, downBook);
        }
      }
    } catch {
      // Silently swallow — REST poll will retry on next tick
    } finally {
      this.restFetchInFlight = false;
    }
  }

  // ── Emergency Exit ───────────────────────────────────────────────────

  /**
   * Start checking for time-based exit.
   * If leg2 hasn't been found with N minutes remaining, liquidate leg1.
   * No price-based stop-loss — binary option volatility is normal.
   */
  private startEmergencyTimer(): void {
    if (!this.config.risk.emergencyEnabled) return;
    this.clearEmergencyTimer();

    const exitThresholdSecs = this.config.risk.exitBeforeExpiryMinutes * 60;

    // Check every second if we're running out of time
    this.emergencyTimer = setInterval(() => {
      if (!this.leg1 || this.state !== StrategyState.WAITING_FOR_HEDGE) return;

      const secsRemaining = Math.max(0, Math.round((this.marketEndTimeMs - Date.now()) / 1000));
      if (secsRemaining <= exitThresholdSecs) {
        this.performEmergencyExit(
          `Time exit: ${secsRemaining}s remaining (< ${this.config.risk.exitBeforeExpiryMinutes}min threshold)`,
        );
      }
    }, 1000);

    this.log('debug',
      `Emergency timer: exit if leg2 not found with ${this.config.risk.exitBeforeExpiryMinutes}min remaining`,
    );
  }

  private clearEmergencyTimer(): void {
    if (this.emergencyTimer) {
      clearInterval(this.emergencyTimer);
      this.emergencyTimer = null;
    }
  }

  /**
   * Sell leg1 at market when time is running out and no hedge was found.
   *
   * P&L uses the last known market price as the estimated exit price,
   * not a 100% loss assumption. In live mode, a FOK market sell is placed;
   * in paper mode, only the P&L is tracked.
   */
  private async performEmergencyExit(reason: string): Promise<void> {
    if (!this.leg1) return;

    this.log('warn', `EMERGENCY EXIT: ${reason} — selling ${this.leg1.shares} ${this.leg1.side}`);
    this.setState(StrategyState.EMERGENCY_EXIT);
    this.stats.emergencyExits++;

    // P&L: estimated exit value = lastMarketPrice × shares (not 100% loss)
    const history = this.leg1.side === Side.UP ? this.upHistory : this.downHistory;
    const lastMarketPrice = history.at(-1)?.price ?? new Decimal(0);
    const entryValue = this.leg1.price.times(this.leg1.shares);
    const exitValue = lastMarketPrice.times(this.leg1.shares);
    const profit = exitValue.minus(entryValue);
    const profitPct = entryValue.isZero()
      ? new Decimal(0)
      : profit.dividedBy(entryValue);

    this.emit('emergencyExit', { leg1: this.leg1, reason, sellPrice: lastMarketPrice });

    if (!this.config.paper.enabled) {
      // Cancel any pending leg2 GTC buy before selling
      if (this.pendingLeg2OrderId) {
        try {
          await this.sdk.tradingService.cancelOrder(this.pendingLeg2OrderId);
        } catch { /* may already be cancelled */ }
        this.expectedOrderIds.delete(this.pendingLeg2OrderId);
        this.pendingLeg2OrderId = null;
      }
      // Cancel leg1's $0.99 exit sell (we're replacing with emergency FOK sell)
      if (this.leg1SellOrderId) {
        try {
          await this.sdk.tradingService.cancelOrder(this.leg1SellOrderId);
        } catch { /* may already be filled/cancelled */ }
        this.leg1SellOrderId = null;
      }
      try {
        await this.sdk.tradingService.createMarketOrder({
          tokenId: this.leg1.tokenId,
          side: 'SELL',
          amount: this.leg1.shares.toNumber(),
          orderType: 'FOK',
        });
        this.log('info', 'Emergency sell executed');
      } catch (err) {
        this.log('error', `Emergency sell failed: ${err}`);
      }
    }

    const result: CycleResult = {
      roundSlug: this.currentRound ?? 'unknown',
      leg1: this.leg1,
      leg2: null,
      totalCost: entryValue,
      payout: exitValue,
      profit,
      profitPct,
      status: 'emergency_exit',
      completedAt: new Date(),
    };

    this.emit('cycleComplete', result);
    this.stats.cyclesAbandoned++;
    this.stats.totalProfit = this.stats.totalProfit.plus(profit);
    this.positionSizer.recordResult(profit.toNumber());
    this.updateWinRate();
    await this.resetCycle();
  }

  // ── Exit Sell Orders ─────────────────────────────────────────────

  /**
   * Place a $0.99 GTC SELL immediately when a leg fills.
   * - Winning side may fill at $0.99 before expiry → instant capital recycling
   * - Losing side won't fill → expires worthless
   * - If nothing fills → settlement pays $1.00 for winner (autoSettle fallback)
   *
   * Paper mode: logs the intent but doesn't place a real order.
   * The PaperTrader handles P&L tracking independently.
   */
  private async placeExitSell(leg: LegInfo, legNum: 1 | 2): Promise<void> {
    const SELL_PRICE = 0.99;

    if (this.config.paper.enabled) {
      // Paper mode — log only, no real order. P&L is tracked via cycleComplete events.
      this.log('info',
        `EXIT SELL placed: ${leg.shares} ${leg.side} @ $${SELL_PRICE} GTC (settlement fallback)`,
      );
      return;
    }

    try {
      const order = await this.sdk.tradingService.createLimitOrder({
        tokenId: leg.tokenId,
        side: 'SELL',
        price: SELL_PRICE,
        size: leg.shares.toNumber(),
        orderType: 'GTC',
      });
      const orderId = order.orderId ?? null;

      if (legNum === 1) {
        this.leg1SellOrderId = orderId;
      } else {
        this.leg2SellOrderId = orderId;
      }

      this.log('info',
        `EXIT SELL placed: ${leg.shares} ${leg.side} @ $${SELL_PRICE} GTC ` +
        `(orderId=${orderId ?? 'unknown'}, settlement fallback)`,
      );
    } catch (err) {
      this.log('error', `Failed to place exit sell for ${leg.side}: ${err}`);
    }
  }

  // ── Price History ────────────────────────────────────────────────────

  private recordPrice(signal: any): void {
    const now = Date.now();

    if (signal.upPrice != null) {
      this.upHistory.push({ price: new Decimal(signal.upPrice), timestamp: now });
    }
    if (signal.downPrice != null) {
      this.downHistory.push({ price: new Decimal(signal.downPrice), timestamp: now });
    }
    // Also accept generic price updates
    if (signal.currentPrice != null && signal.dipSide) {
      const history = signal.dipSide === 'UP' ? this.upHistory : this.downHistory;
      history.push({ price: new Decimal(signal.currentPrice), timestamp: now });
    }
    if (signal.oppositeAsk != null && signal.dipSide) {
      const history = signal.dipSide === 'UP' ? this.downHistory : this.upHistory;
      history.push({ price: new Decimal(signal.oppositeAsk), timestamp: now });
    }

    // Emit price update for TUI (use current orderbook state)
    const dipArb = this.sdk.dipArb as any;
    const lastUpAsk = this.upHistory.at(-1)?.price.toNumber() ?? 0;
    const lastDownAsk = this.downHistory.at(-1)?.price.toNumber() ?? 0;
    this.emit('priceUpdate', {
      upAsk: lastUpAsk,
      upAskSize: Number(dipArb.upAsks?.[0]?.size) || 0,
      upBid: this.upBids[0]?.price ?? 0,
      upBidSize: this.upBids[0]?.size ?? 0,
      downAsk: lastDownAsk,
      downAskSize: Number(dipArb.downAsks?.[0]?.size) || 0,
      downBid: this.downBids[0]?.price ?? 0,
      downBidSize: this.downBids[0]?.size ?? 0,
      sum: lastUpAsk + lastDownAsk,
    });

    // Trim old history
    const cutoff = now - 5 * 60 * 1000; // 5 minutes
    this.upHistory = this.upHistory.filter(p => p.timestamp >= cutoff);
    this.downHistory = this.downHistory.filter(p => p.timestamp >= cutoff);
  }

  // ── SDK State Sync ──────────────────────────────────────────────────

  /**
   * Advance the SDK's internal round phase to 'leg1_filled'.
   *
   * With autoExecute: false the SDK emits leg1 signals but never
   * transitions its own state machine — detectSignal() keeps calling
   * detectLeg1Signal() instead of detectLeg2Signal(). Manually setting
   * currentRound.phase tells the SDK we filled leg1 so it starts
   * emitting leg2 hedge signals.
   */
  private notifySdkLeg1Filled(leg: LegInfo): void {
    const dipArb = this.sdk.dipArb as any;
    if (!dipArb.currentRound) return;

    dipArb.currentRound.phase = 'leg1_filled';
    dipArb.currentRound.leg1 = {
      side: leg.side === Side.UP ? 'UP' : 'DOWN',
      price: leg.price.toNumber(),
      shares: leg.shares.toNumber(),
      timestamp: Date.now(),
      tokenId: leg.tokenId,
    };
    this.log('debug', 'SDK notified: leg1 filled, now looking for leg2');
  }

  // ── State Management ─────────────────────────────────────────────────

  private setState(newState: StrategyState): void {
    this.state = newState;
    this.emit('stateChange', newState);
  }

  private async resetCycle(): Promise<void> {
    // Cancel any orphaned GTC orders (Issue 9)
    this.clearFillPollTimer();
    if (this.pendingLeg1OrderId && !this.config.paper.enabled) {
      try {
        await this.sdk.tradingService.cancelOrder(this.pendingLeg1OrderId);
        this.log('info', `Cancelled orphaned leg1 order: ${this.pendingLeg1OrderId}`);
      } catch { /* order may already be filled/cancelled */ }
      this.expectedOrderIds.delete(this.pendingLeg1OrderId);
    }
    this.pendingLeg1OrderId = null;

    if (this.pendingLeg2OrderId && !this.config.paper.enabled) {
      try {
        await this.sdk.tradingService.cancelOrder(this.pendingLeg2OrderId);
        this.log('info', `Cancelled orphaned leg2 order: ${this.pendingLeg2OrderId}`);
      } catch { /* order may already be filled/cancelled */ }
      this.expectedOrderIds.delete(this.pendingLeg2OrderId);
    }
    this.pendingLeg2OrderId = null;

    this.leg1 = null;
    this.leg2 = null;
    this.cycleFinalized = false;
    // Don't cancel sell orders — they stay on the book for settlement/auto-fill
    this.leg1SellOrderId = null;
    this.leg2SellOrderId = null;
    this.clearEmergencyTimer();
    this.setState(StrategyState.WATCHING);
  }

  private updateWinRate(): void {
    const total = this.stats.cyclesCompleted + this.stats.cyclesAbandoned;
    this.stats.winRate = total > 0 ? this.stats.cyclesWon / total : 0;
  }

  // ── Public Getters ───────────────────────────────────────────────────

  getState(): StrategyState { return this.state; }
  getStats(): StrategyStats { return { ...this.stats }; }
  getLeg1(): LegInfo | null { return this.leg1; }
  getCurrentRound(): string | null { return this.currentRound; }
  getPositionSizer(): PositionSizer { return this.positionSizer; }

  /** Update the balance the position sizer uses for sizing decisions. */
  updateBalance(balance: number): void {
    this.currentBalance = balance;
  }

  // ── Logging ──────────────────────────────────────────────────────────

  private log(level: string, message: string): void {
    this.emit('log', { message, timestamp: new Date(), level });
  }
}
