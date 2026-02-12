# PolyBot v2.0

Arbitrage bot for Polymarket's BTC 15-minute binary options markets. Buys temporary price dips on one side (UP/DOWN), then hedges the opposite side — locking in profit when the combined cost is under $1.00.

Built with TypeScript, poly-sdk, and a React terminal UI (Ink).

## How It Works

Polymarket 15-minute crypto markets have two tokens: **UP** and **DOWN**. One of them always pays $1.00 at expiry.

When volatility spikes, one side temporarily dips in price. If you buy the dip **and** hedge the opposite side before prices normalize, the combined cost is under $1.00 — guaranteed $1.00 payout at settlement minus your cost = profit.

```
Example:
  BTC UP  dips to $0.42 → buy 50 shares ($21.00)
  BTC DOWN ask   = $0.49 → buy 50 shares ($24.50)
  Total cost              = $45.50
  Payout (one side wins)  = $50.00
  Profit                  = $4.50 (9.9%)
```

### Layers on top of the base SDK

1. **Fee-Aware Orders** — uses GTC maker orders (0% fee) instead of FOK taker orders (~3% fee) when margin is thin
2. **GTC Fill Tracking** — polls `getOrder()` for explicit fill status with partial-fill handling
3. **$0.99 Exit Sells** — immediate GTC SELL at $0.99 on each leg fill for instant capital recycling
4. **Emergency Exit** — time-based protection for positions that never get hedged
5. **Explicit Settlement** — redeems resolved positions after each round (with autoSettle as fallback)

## Quick Start

```bash
# Install dependencies
npm install

# Run in paper trading mode (no wallet needed)
npm run dev

# Run tests
npm test
```

Paper mode starts with $1,000 virtual balance and simulates Polymarket's quadratic taker fees + slippage.

## Live Trading

```bash
# 1. Set your Polymarket wallet private key
cp .env.example .env
# Edit .env → set POLYMARKET_PRIVATE_KEY=0x...

# 2. Disable paper mode in config.toml
# Set [paper] enabled = false

# 3. Run
npm run dev
```

> **Warning**: Live trading uses real money on Polygon. Start with small `max_shares` and `max_balance_pct_per_trade` values. Run paper mode first to validate the strategy on current market conditions.

## Configuration

All settings live in `config.toml` (4 sections). See [docs/SETUP.md](docs/SETUP.md) for the full configuration reference and tuning guide.

Key sections:
- `[trading]` — asset selection, entry thresholds, order types
- `[risk]` — position sizing, consecutive loss circuit breaker, emergency exit
- `[paper]` — paper trading simulation settings

## Terminal UI

The bot runs a real-time dashboard in your terminal:

| Panel | Shows |
|-------|-------|
| **Price** | UP/DOWN ask prices, sum (green if profitable) |
| **Positions** | Open legs, balance, P&L |
| **History** | Recent cycle results |
| **Logs** | Strategy events, filtered signals, errors |
| **Status Bar** | State, round countdown, mode |

Commands: `help`, `status`, `stats`, `balance`, `quit`

## Project Structure

```
src/
├── index.ts                    # Entry point — wires SDK, strategy, paper trader, TUI
├── config.ts                   # TOML config loader + TypeScript interfaces
├── strategy/
│   ├── enhanced-dip-arb.ts     # Core strategy (signal gating, execution, emergency exit)
│   ├── fee-aware-orders.ts     # GTC vs FOK decision logic + fee estimation
│   ├── position-sizer.ts       # Dynamic sizing + circuit breakers
├── paper/
│   └── paper-trader.ts         # Paper trading simulator with realistic fees
├── terminal/
│   ├── app.tsx                 # Main TUI layout (Ink/React)
│   ├── hooks/                  # React hooks for strategy/market/paper state
│   └── components/             # PricePanel, PositionsPanel, HistoryPanel, etc.
├── types/
│   └── strategy.ts             # StrategyState, LegInfo, CycleResult, etc.
tests/
├── enhanced-dip-arb.test.ts    # 67 tests — strategy state machine, fill polling, emergency exit
├── fee-aware-orders.test.ts    # 23 tests — GTC vs FOK decision logic
├── paper-trader.test.ts        # 48 tests — paper trading simulation
├── position-sizer.test.ts      # 20 tests — sizing, circuit breaker, cooldown
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with tsx (development, paper or live) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm start` | Run compiled build |
| `npm test` | Run tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |

## Tech Stack

- **Runtime**: Node.js (ES modules)
- **Language**: TypeScript 5.7
- **SDK**: [@catalyst-team/poly-sdk](https://github.com/cyl19970726/poly-sdk) (Polymarket)
- **UI**: React 18 + Ink 4 (terminal rendering)
- **Math**: decimal.js (precision arithmetic)
- **Config**: TOML + dotenv
- **Tests**: Vitest

## License

Private — not for redistribution.
