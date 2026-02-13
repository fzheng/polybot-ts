/**
 * Headless runner — runs the strategy without the TUI, logging to a file.
 * Usage: npx tsx src/headless.ts
 */
import fs from 'fs';
import Decimal from 'decimal.js';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { loadConfig } from './config.js';
import { EnhancedDipArbStrategy } from './strategy/enhanced-dip-arb.js';
import { PaperTrader } from './paper/paper-trader.js';

const LOG_FILE = 'polybot.log';

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(msg: string): void {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function main() {
  // Clear log file
  fs.writeFileSync(LOG_FILE, '');
  log('=== PolyBot Headless Mode ===');

  const config = loadConfig('config.toml');
  log(`Paper mode: ${config.paper.enabled}, balance: $${config.paper.startingBalance}`);

  // Initialize SDK
  let sdk: PolymarketSDK;
  if (config.paper.enabled) {
    sdk = await PolymarketSDK.create({});
  } else {
    if (!config.api.privateKey) {
      log('ERROR: POLYMARKET_PRIVATE_KEY required for live trading');
      process.exit(1);
    }
    sdk = await PolymarketSDK.create({ privateKey: config.api.privateKey });
  }

  const paperTrader = config.paper.enabled ? new PaperTrader(config.paper, config.trading) : null;
  const strategy = new EnhancedDipArbStrategy(sdk, config);

  // Wire paper trader
  if (paperTrader) {
    strategy.on('leg1Executed', async (leg) => {
      const round = strategy.getCurrentRound() ?? 'unknown';
      await paperTrader.buy(leg, round);
      strategy.updateBalance(paperTrader.getBalance().toNumber());
    });
    strategy.on('leg2Executed', async (leg) => {
      const round = strategy.getCurrentRound() ?? 'unknown';
      await paperTrader.buy(leg, round);
      strategy.updateBalance(paperTrader.getBalance().toNumber());
    });
    strategy.on('cycleComplete', async (result) => {
      paperTrader.recordCycle(result);
      if (result.status === 'completed' && result.leg1) {
        const round = result.roundSlug;
        await paperTrader.sell(result.leg1.tokenId, result.leg1.side, result.leg1.shares, new Decimal(0.99), round);
        paperTrader.abandonRound(round);
      }
      strategy.updateBalance(paperTrader.getBalance().toNumber());
    });
    strategy.on('emergencyExit', async (info) => {
      const round = strategy.getCurrentRound() ?? 'unknown';
      if (info.leg1 && info.sellPrice) {
        await paperTrader.sell(info.leg1.tokenId, info.leg1.side, info.leg1.shares, info.sellPrice, round);
      } else {
        paperTrader.abandonRound(round);
      }
      strategy.updateBalance(paperTrader.getBalance().toNumber());
    });
  }

  // Log all strategy events
  strategy.on('log', (entry: any) => {
    log(`[${entry.level}] ${entry.message}`);
  });
  strategy.on('stateChange', (state: string) => {
    log(`State → ${state}`);
  });
  strategy.on('newRound', (data: any) => {
    log(`New round: ${data.slug} (${data.secondsRemaining}s remaining)`);
  });
  strategy.on('priceUpdate', (data: any) => {
    // Log price every 30 seconds to avoid spam
    if (!main._lastPriceLog || Date.now() - main._lastPriceLog > 30_000) {
      main._lastPriceLog = Date.now();
      log(`Prices: UP bid=${data.upBid?.toFixed(4) ?? '-.--'} ask=${data.upAsk?.toFixed(4) ?? '-.--'} | DOWN bid=${data.downBid?.toFixed(4) ?? '-.--'} ask=${data.downAsk?.toFixed(4) ?? '-.--'} | SUM=${data.sum?.toFixed(4) ?? '-.--'}`);
    }
  });

  log('Starting strategy...');
  await strategy.start();
  log('Strategy started. Monitoring...');

  // Keep alive
  process.on('SIGINT', async () => {
    log('Shutting down...');
    await strategy.stop();
    process.exit(0);
  });
}

// Helper for throttling price logs
main._lastPriceLog = 0 as number;

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
