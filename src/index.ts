import React from 'react';
import { render } from 'ink';
import Decimal from 'decimal.js';
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
import { loadConfig } from './config.js';
import { EnhancedDipArbStrategy } from './strategy/enhanced-dip-arb.js';
import { PaperTrader } from './paper/paper-trader.js';
import { App } from './terminal/app.js';
import { createSessionLogger, type SessionLogger } from './logging/session-logger.js';

let sessionLogger: SessionLogger | null = null;

async function main() {
  // ── Load config ────────────────────────────────────────────────────
  const configPath = process.argv.includes('--config')
    ? process.argv[process.argv.indexOf('--config') + 1]
    : 'config.toml';

  const config = loadConfig(configPath);
  sessionLogger = createSessionLogger('tui');
  sessionLogger.log(`Session log file: ${sessionLogger.filePath}`);
  sessionLogger.log(`Mode: ${config.paper.enabled ? 'paper' : 'live'}`);
  console.error(`Session log file: ${sessionLogger.filePath}`);

  // ── Initialize poly-sdk ────────────────────────────────────────────
  let sdk: PolymarketSDK;
  if (config.paper.enabled) {
    // Paper mode: read-only SDK (no private key needed)
    sdk = await PolymarketSDK.create({});
  } else {
    if (!config.api.privateKey) {
      console.error('ERROR: POLYMARKET_PRIVATE_KEY is required for live trading.');
      console.error('Set it in .env or as an environment variable.');
      process.exit(1);
    }
    sdk = await PolymarketSDK.create({
      privateKey: config.api.privateKey,
    });
  }

  // ── Paper trader ───────────────────────────────────────────────────
  const paperTrader = config.paper.enabled
    ? new PaperTrader(config.paper, config.trading)
    : null;

  // ── Strategy ───────────────────────────────────────────────────────
  const strategy = new EnhancedDipArbStrategy(sdk, config);
  strategy.on('log', (entry: { level: string; message: string }) => {
    sessionLogger?.log(`[strategy:${entry.level}] ${entry.message}`);
  });
  strategy.on('stateChange', (state: string) => {
    sessionLogger?.log(`[state] ${state}`);
  });
  strategy.on('newRound', (data: { slug: string; secondsRemaining: number }) => {
    sessionLogger?.log(`[round] ${data.slug} (${data.secondsRemaining}s remaining)`);
  });
  strategy.on('error', (err: Error) => {
    sessionLogger?.log(`[strategy:error] ${err.message}`);
  });

  // Wire paper trader to strategy events
  if (paperTrader) {
    paperTrader.on('trade', (trade: any) => {
      sessionLogger?.log(
        `[paper:trade] side=${String(trade.side)} shares=${trade.shares?.toString?.() ?? trade.shares} ` +
        `price=${trade.price?.toString?.() ?? trade.price}`,
      );
    });
    paperTrader.on('settled', (settled: any) => {
      sessionLogger?.log(
        `[paper:settled] round=${settled.roundSlug} winning=${settled.winningSide} ` +
        `payout=${settled.payout?.toString?.() ?? settled.payout}`,
      );
    });

    strategy.on('leg1Executed', async (leg) => {
      const round = strategy.getCurrentRound() ?? 'unknown';
      await paperTrader.buy(leg, round);
      // Update strategy's balance knowledge after each trade
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
        // Both legs filled → $0.99 exit sells placed → simulate winning side payout
        // One side wins at $0.99, other expires worthless. Credit $0.99 * shares.
        const round = result.roundSlug;
        await paperTrader.sell(
          result.leg1.tokenId,
          result.leg1.side,
          result.leg1.shares,
          new Decimal(0.99),
          round,
        );
        // Remove the losing side's position (expires worthless)
        paperTrader.abandonRound(round);
      }
      strategy.updateBalance(paperTrader.getBalance().toNumber());
    });

    strategy.on('emergencyExit', async (info) => {
      const round = strategy.getCurrentRound() ?? 'unknown';
      if (info.leg1 && info.sellPrice) {
        await paperTrader.sell(
          info.leg1.tokenId,
          info.leg1.side,
          info.leg1.shares,
          info.sellPrice,
          round,
        );
      } else {
        paperTrader.abandonRound(round);
      }
      strategy.updateBalance(paperTrader.getBalance().toNumber());
    });
  }

  // ── Render TUI first — must subscribe to events BEFORE strategy starts ──
  const { waitUntilExit } = render(
    React.createElement(App, { config, strategy, paperTrader }),
  );

  // ── Start strategy after TUI is listening for events ──────────────
  await strategy.start();

  // Wait for user to quit
  await waitUntilExit();

  // Cleanup
  await strategy.stop();
  await sessionLogger?.close();
  process.exit(0);
}

main().catch((err) => {
  sessionLogger?.log(`Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  void sessionLogger?.close();
  console.error('Fatal error:', err);
  process.exit(1);
});
