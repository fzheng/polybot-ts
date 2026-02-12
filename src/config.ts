/**
 * Configuration loading and interfaces.
 *
 * Config is loaded from a TOML file (default: config.toml).
 * Fallback defaults here match the documented values in docs/SETUP.md.
 * Private key is loaded from .env (never stored in config.toml).
 */
import fs from 'node:fs';
import TOML from 'toml';
import dotenv from 'dotenv';

export interface ApiConfig {
  clobEndpoint: string;
  gammaEndpoint: string;
  chainId: number;
  privateKey?: string;
  useBinance: boolean;
  maxPriceAgeSecs: number;
}

export interface TradingConfig {
  assets: string[];
  duration: string;
  defaultShares: number;
  defaultSumTarget: number;
  defaultDipThreshold: number;
  windowMinutes: number;
  maxCycles: number;
  dumpWindowMs: number;
  useMakerOrders: boolean;
  makerFallbackToTaker: boolean;
  takerFeeRate: number;
  maxSpreadPct: number;
  gtcFillTimeoutMs: number;
  gtcPollIntervalMs: number;
}

export interface RiskConfig {
  maxBalancePctPerTrade: number;
  minShares: number;
  maxShares: number;
  consecutiveLossLimit: number;
  cooldownMinutes: number;
  emergencyEnabled: boolean;
  exitBeforeExpiryMinutes: number;
}

export interface PaperConfig {
  enabled: boolean;
  startingBalance: number;
  simulateFees: boolean;
  simulateSlippage: boolean;
  slippagePct: number;
  logFile: string;
  recordData: boolean;
  dataDir: string;
  recordIntervalMs: number;
}

export interface BotConfig {
  api: ApiConfig;
  trading: TradingConfig;
  risk: RiskConfig;
  paper: PaperConfig;
}

export function loadConfig(configPath: string = 'config.toml'): BotConfig {
  dotenv.config();

  const raw = TOML.parse(fs.readFileSync(configPath, 'utf-8'));
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY || process.env.PK;

  return {
    api: {
      clobEndpoint: raw.api.clob_endpoint,
      gammaEndpoint: raw.api.gamma_endpoint,
      chainId: raw.api.chain_id ?? 137,
      privateKey,
      useBinance: raw.api.use_binance ?? true,
      maxPriceAgeSecs: raw.api.max_price_age_secs ?? 10,
    },
    trading: {
      assets: raw.trading.assets ?? ['BTC'],
      duration: raw.trading.duration ?? '15m',
      defaultShares: raw.trading.default_shares ?? 20,
      defaultSumTarget: raw.trading.default_sum_target ?? 0.95,
      defaultDipThreshold: raw.trading.default_dip_threshold ?? 0.20,
      windowMinutes: raw.trading.window_minutes ?? 5,
      maxCycles: raw.trading.max_cycles ?? 1,
      dumpWindowMs: raw.trading.dump_window_ms ?? 3000,
      useMakerOrders: raw.trading.use_maker_orders ?? true,
      makerFallbackToTaker: raw.trading.maker_fallback_to_taker ?? true,
      takerFeeRate: raw.trading.taker_fee_rate ?? 0.0625,
      maxSpreadPct: raw.trading.max_spread_pct ?? 0.10,
      gtcFillTimeoutMs: raw.trading.gtc_fill_timeout_ms ?? 30000,
      gtcPollIntervalMs: raw.trading.gtc_poll_interval_ms ?? 1000,
    },
    risk: {
      maxBalancePctPerTrade: raw.risk?.max_balance_pct_per_trade ?? 0.05,
      minShares: raw.risk?.min_shares ?? 5,
      maxShares: raw.risk?.max_shares ?? 100,
      consecutiveLossLimit: raw.risk?.consecutive_loss_limit ?? 3,
      cooldownMinutes: raw.risk?.cooldown_minutes ?? 360,
      emergencyEnabled: raw.risk?.emergency_enabled ?? true,
      exitBeforeExpiryMinutes: raw.risk?.exit_before_expiry_minutes ?? 3,
    },
    paper: {
      enabled: raw.paper.enabled ?? true,
      startingBalance: raw.paper.starting_balance ?? 1000,
      simulateFees: raw.paper.simulate_fees ?? true,
      simulateSlippage: raw.paper.simulate_slippage ?? true,
      slippagePct: raw.paper.slippage_pct ?? 0.02,
      logFile: raw.paper.log_file ?? 'paper_trades.jsonl',
      recordData: raw.paper.record_data ?? true,
      dataDir: raw.paper.data_dir ?? 'data',
      recordIntervalMs: raw.paper.record_interval_ms ?? 1000,
    },
  };
}
