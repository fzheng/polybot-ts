# Setup & How to Run

Step-by-step guide to get PolyBot running. For strategy background, see the [README](../README.md).

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** (comes with Node.js)
- A terminal that supports ANSI colors (Windows Terminal, iTerm2, any Linux terminal)

## 1. Install Dependencies

```bash
git clone <repo-url> && cd polybot-ts
npm install
```

The poly-sdk is installed from GitHub (`@catalyst-team/poly-sdk`). If you get auth errors, make sure you have git access to the SDK repo.

## 2. Paper Trading (No Wallet Needed)

Paper mode is on by default. Just run:

```bash
npm run dev
```

This connects to Polymarket's live price feeds but places **no real orders**. It simulates trades with a $1,000 virtual balance, including realistic taker fees and spread-based slippage.

**What you'll see:** A terminal dashboard with live prices, positions, and trade history. Type `help` in the command prompt for available commands.

## 3. Live Trading

### Set Up Your Wallet

```bash
cp .env.example .env
```

Edit `.env` and add your Polymarket wallet private key:

```
POLYMARKET_PRIVATE_KEY=0x1234abcd...your_private_key_here
```

This is a Polygon wallet private key. The wallet needs USDC on Polygon for trading.

### Switch to Live Mode

In `config.toml`, change:

```toml
[paper]
enabled = false    # was: true
```

### Run

```bash
npm run dev
```

> **Start small.** Set `max_shares = 10` and `max_balance_pct_per_trade = 0.02` until you're confident the bot behaves correctly on live markets.

## 4. Custom Config Path

```bash
npm run dev -- --config my-config.toml
```

## 5. Build & Run Compiled

```bash
npm run build          # TypeScript → dist/
npm start              # Run compiled JS
```

## 6. Run Tests

```bash
npm test               # Single run
npm run test:watch     # Watch mode
```

Tests cover fee calculation, position sizing, and circuit breakers.

---

# Configuration Reference

All configuration lives in `config.toml` (4 sections).
Private keys are loaded from `.env` (never put them in config.toml).

---

## [api] — Endpoints & Oracle

Connection settings for Polymarket and the price oracle.

```toml
[api]
clob_endpoint = "https://clob.polymarket.com"
gamma_endpoint = "https://gamma-api.polymarket.com"
chain_id = 137
use_binance = true
max_price_age_secs = 10
```

| Parameter | Default | Description |
|---|---|---|
| `clob_endpoint` | `https://clob.polymarket.com` | Polymarket CLOB API. Don't change unless using a testnet. |
| `gamma_endpoint` | `https://gamma-api.polymarket.com` | Polymarket market metadata API. |
| `chain_id` | `137` | Polygon mainnet. Don't change. |
| `use_binance` | `true` | Use Binance BTC/ETH spot price as fair-value reference for trend detection. |
| `max_price_age_secs` | `10` | Reject oracle prices older than this. Lower = stricter but may cause gaps. |

**Environment variables** (loaded from `.env`):
- `POLYMARKET_PRIVATE_KEY` — Your wallet private key (hex, with or without `0x`). Required for live trading.
- `PK` — Alias for the above.

---

## [trading] — Strategy Parameters

Core dip-arb strategy settings. These control *what* to trade and *when* to enter.

```toml
[trading]
assets = ["BTC"]
duration = "15m"
default_shares = 20
default_sum_target = 0.95
default_dip_threshold = 0.20
window_minutes = 5
max_cycles = 1
dump_window_ms = 3000
use_maker_orders = true
maker_fallback_to_taker = true
taker_fee_rate = 0.0625
max_spread_pct = 0.10
gtc_fill_timeout_ms = 30000
gtc_poll_interval_ms = 1000
```

### Market Selection

| Parameter | Default | Description |
|---|---|---|
| `assets` | `["BTC"]` | Which coins to trade. Options: `"BTC"`, `"ETH"`, `"SOL"`, `"XRP"`. Use an array for multi-asset rotation. |
| `duration` | `"15m"` | Market duration. `"15m"` for 15-minute rounds, `"1h"` for hourly. |

**Examples:**
```toml
assets = ["BTC"]              # BTC only
assets = ["ETH"]              # ETH only
assets = ["BTC", "ETH"]       # Rotate between BTC and ETH markets
assets = ["BTC", "ETH", "SOL"] # All three
```

### Entry Logic

The bot enters **once per market** — a single Leg 1 + Leg 2 cycle per 15-minute round. There is no re-entry after a completed cycle or an emergency exit.

| Parameter | Default | Range | Description |
|---|---|---|---|
| `default_sum_target` | `0.95` | 0.85–0.98 | Maximum `leg1_price + leg2_price` to accept. Lower = pickier, fewer trades, higher profit per trade. |
| `default_dip_threshold` | `0.20` | 0.05–0.30 | Minimum % price drop in the sliding window to trigger Leg 1. `0.20` = 20% drop. Lower = more signals (noisier). |
| `window_minutes` | `5` | 1–10 | Only enter trades in the first N minutes of a round. Lower = safer (more time for Leg 2). |
| `max_cycles` | `1` | 1 | Reserved. One entry per market is hardcoded via `cycleAttemptedThisRound`. |
| `dump_window_ms` | `3000` | 1000–10000 | Sliding window (ms) for dump detection. `3000` = looks at 3-second price change. Shorter = more sensitive. |
| `default_shares` | `20` | — | Fallback share count. Overridden by the position sizer's dynamic calculation in practice. |

### Order Type & Fees

| Parameter | Default | Description |
|---|---|---|
| `use_maker_orders` | `true` | Prefer GTC limit orders (maker, 0% fee) over FOK market orders (taker, ~3% fee). **Strongly recommended = true.** |
| `maker_fallback_to_taker` | `true` | Allow FOK taker orders when profit margin greatly exceeds the fee. If `false`, always uses GTC even with huge margin. |
| `taker_fee_rate` | `0.0625` | Polymarket fee rate for 15-min crypto markets (`fee_rate_bps=1000`). Fee formula: `fee_per_share = price * (1-price) * 0.0625`. Don't change unless Polymarket updates fees. |
| `max_spread_pct` | `0.10` | Skip entry if bid-ask spread exceeds X% of best bid. `0.10` = 10%. Prevents buying into illiquid books. |

### GTC Order Management

| Parameter | Default | Description |
|---|---|---|
| `gtc_fill_timeout_ms` | `30000` | Cancel unfilled GTC limit orders after this many ms. `30000` = 30s. |
| `gtc_poll_interval_ms` | `1000` | Poll for GTC fill confirmation every N ms. Uses `getOrder(orderId)` with explicit status checks. |

**Fill detection:** The bot polls the order's status via `getOrder()` (not `getOpenOrders()`). This gives explicit status for each outcome:
- **Filled** → advance to next state
- **Cancelled/Expired/Rejected** → check `filledSize` for partial fills; if partially filled, treat as a fill with the actual quantity; if zero fill, reset or emergency exit
- **Still active** (pending/open) → continue polling; cancel after timeout

### Exit Strategy: Immediate $0.99 Sell on Fill

When each leg (Leg 1 or Leg 2) fills, the bot immediately places a **GTC SELL order at $0.99** for that position. This replaces the old time-based liquidation approach.

**How it works:**
- After buying UP tokens at (e.g.) $0.40, a GTC SELL @ $0.99 is placed right away.
- After buying DOWN tokens at (e.g.) $0.55, a GTC SELL @ $0.99 is placed right away.
- Near expiry, the **winning** side's price approaches $1.00, so the $0.99 sell fills — locking in profit instantly.
- The **losing** side's price approaches $0, so its $0.99 sell never fills — tokens expire worthless.
- The SDK's `autoSettle: true` redeems any remaining tokens after market resolution as a fallback.

**Why $0.99 instead of settlement?** Settlement on Polymarket requires waiting for resolution + a claim transaction, locking capital for minutes. The $0.99 sell fills as soon as the winning side is clearly winning, recycling capital immediately for the next round.

**Paper mode note:** In paper trading, exit sells are logged but not actually placed. P&L is tracked through `cycleComplete` events. The PaperTrader handles balance and fee simulation independently.

**Explicit settlement:** After each round completes, the bot calls `dipArb.settle('redeem')` to redeem any resolved positions that weren't sold via the $0.99 exit (e.g., the losing side's tokens that expired worthless). This is in addition to the SDK's `autoSettle` fallback.

**Fee at different prices** (per share, with `taker_fee_rate = 0.0625`):

| Share Price | Fee/Share | Fee % of Cost |
|---|---|---|
| $0.50 | $0.0156 | 3.13% |
| $0.40 | $0.0150 | 3.75% |
| $0.30 | $0.0131 | 4.38% |
| $0.20 | $0.0100 | 5.00% |

---

## [risk] — Position Sizing, Circuit Breakers & Emergency Exit

Controls *how much* to bet and *when to stop*.

```toml
[risk]
max_balance_pct_per_trade = 0.05
min_shares = 5
max_shares = 100
consecutive_loss_limit = 3
cooldown_minutes = 360
emergency_enabled = true
exit_before_expiry_minutes = 3
```

### Position Sizing

Determines shares per trade: `shares = floor(balance * max_balance_pct_per_trade / leg1_price)`, capped at `max_shares`. If the result is below `min_shares`, the trade is **skipped** (returns 0 shares) rather than forced up to the minimum — this prevents over-sizing when the budget is too small.

| Parameter | Default | Range | Description |
|---|---|---|---|
| `max_balance_pct_per_trade` | `0.05` | 0.01–0.20 | Risk at most X% of balance per cycle. `0.05` = 5%. This is the single most important risk parameter. |
| `min_shares` | `5` | 5+ | Polymarket minimum order size. Don't go below 5. |
| `max_shares` | `100` | 10–500 | Absolute cap per leg regardless of balance. |

**Example sizing at $1000 balance, price $0.40:**
```
max_balance_pct = 0.05 → risk = $50 → shares = 50/0.40 = 125 → capped at 100
max_balance_pct = 0.03 → risk = $30 → shares = 30/0.40 = 75
max_balance_pct = 0.10 → risk = $100 → shares = 100/0.40 = 250 → capped at 100
```

Safety rail: never uses more than 95% of balance regardless of settings.

### Circuit Breaker

Automatically pause trading after consecutive losses.

| Parameter | Default | Description |
|---|---|---|
| `consecutive_loss_limit` | `3` | Pause after N consecutive losing trades. |
| `cooldown_minutes` | `360` | How long to pause (minutes) after hitting the consecutive loss limit. `360` = 6 hours. |

**How it works:** After 3 consecutive losing cycles (emergency exits count as losses), trading pauses for 6 hours. A single winning cycle resets the consecutive loss counter. The cooldown is long because repeated losses in short-term binary options usually indicate unfavorable market conditions — waiting for a regime change is better than grinding into losses.

### Emergency Exit (Time-Based)

Protects against stuck Leg 1 positions that never get a Leg 2 hedge. The emergency exit is **purely time-based** — it triggers when time is running out on the current round, not based on price movement.

| Parameter | Default | Range | Description |
|---|---|---|---|
| `emergency_enabled` | `true` | — | Master switch. **false = dangerous** — stuck positions held until round expires with no hedge. |
| `exit_before_expiry_minutes` | `3` | 1–10 | Sell Leg 1 at market (FOK) if Leg 2 hasn't filled with this many minutes remaining in the round. |

**How it works:** Once Leg 1 fills, a timer starts checking every second how many minutes remain in the current round. If Leg 2 hasn't been found and only `exit_before_expiry_minutes` remain, Leg 1 is sold at market price via a FOK (Fill-or-Kill) order to cut the loss. In live mode, any pending Leg 2 GTC buy and the Leg 1 $0.99 exit sell are cancelled before the emergency FOK sell.

**P&L tracking:** Emergency exit profit/loss is calculated using the last known market price (from the price history), not assumed as a 100% loss. This gives more accurate P&L when the token still has residual value. Emergency exits count as losses for the circuit breaker's consecutive loss tracking.

**Why time-based and not price-based?** Binary option prices are inherently volatile — a 20% drop in price is normal market behavior, not a signal of permanent loss. Price-based stop-losses in this market cause cascading false exits. Time-based exit is the right mechanism: if the hedge can't be found before time runs out, exit to avoid unhedged expiry.

**One entry per market:** After any emergency exit, the bot does **not** re-enter the same round. It waits for the next 15-minute market to start fresh. This prevents cascading losses from repeated entries in unfavorable conditions.

---

## [paper] — Paper Trading & Data Recording

Simulation settings. When `enabled = true`, no real orders are placed.

```toml
[paper]
enabled = true
starting_balance = 1000.0
simulate_fees = true
simulate_slippage = true
slippage_pct = 0.02
log_file = "paper_trades.jsonl"
record_data = true
data_dir = "data"
record_interval_ms = 1000
```

| Parameter | Default | Description |
|---|---|---|
| `enabled` | `true` | **true = paper mode** (no real money). **false = live trading** (requires private key). |
| `starting_balance` | `1000.0` | Virtual starting balance in USDC. |
| `simulate_fees` | `true` | Apply the quadratic taker fee model to paper trades. Recommended true for realistic P&L. |
| `simulate_slippage` | `true` | Add spread-based slippage to simulated fills. FOK orders fill at `bestAsk` + size-scaled slippage. GTC orders fill at limit price (zero slippage). |
| `slippage_pct` | `0.02` | Fallback slippage percentage when orderbook data is unavailable. `0.02` = 2%. |
| `log_file` | `paper_trades.jsonl` | File to log all paper trades (JSON Lines format). |
| `record_data` | `true` | Record raw price data to disk for later analysis. |
| `data_dir` | `data` | Output directory for price recordings. |
| `record_interval_ms` | `1000` | How often to record prices (ms). `1000` = once per second. |

---

## Preset Profiles

### Conservative (fewer trades, protect capital)
```toml
[trading]
default_sum_target = 0.90
default_dip_threshold = 0.25
window_minutes = 3

[risk]
max_balance_pct_per_trade = 0.03
consecutive_loss_limit = 2
cooldown_minutes = 720
exit_before_expiry_minutes = 5
```

### Moderate (balanced)
```toml
[trading]
default_sum_target = 0.95
default_dip_threshold = 0.20
window_minutes = 5

[risk]
max_balance_pct_per_trade = 0.05
consecutive_loss_limit = 3
cooldown_minutes = 360
exit_before_expiry_minutes = 3
```

### Aggressive (more trades, higher risk/reward)
```toml
[trading]
default_sum_target = 0.97
default_dip_threshold = 0.15
window_minutes = 7

[risk]
max_balance_pct_per_trade = 0.10
max_shares = 200
consecutive_loss_limit = 5
cooldown_minutes = 180
exit_before_expiry_minutes = 2
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module '@catalyst-team/poly-sdk'` | Run `npm install` — the SDK installs from GitHub |
| `POLYMARKET_PRIVATE_KEY is required` | Create `.env` file from `.env.example` and add your key |
| No signals / no trades | Market may be quiet. Lower `default_dip_threshold` to 0.15 or wait for volatile BTC movement |
| Emergency exits every round | Increase `exit_before_expiry_minutes` to give more time for Leg 2, or check if `default_sum_target` is too tight (raise it) |
| Terminal UI garbled | Use a modern terminal (Windows Terminal, not cmd.exe). Must support ANSI escape codes. |
| Bot monitoring wrong market | This was fixed — the bot now validates that the current time falls within the market's 15-min window before subscribing |
| Bot fails to start / "no market" | The bot retries up to 3 times with 30s delays when no active market is found at startup. If all attempts fail, it emits an error event. Check that the Polymarket API is reachable and that active 15-min crypto markets exist. |

## Full Default config.toml

```toml
[api]
clob_endpoint = "https://clob.polymarket.com"
gamma_endpoint = "https://gamma-api.polymarket.com"
chain_id = 137
use_binance = true
max_price_age_secs = 10

[trading]
assets = ["BTC"]
duration = "15m"
default_shares = 20
default_sum_target = 0.95
default_dip_threshold = 0.20
window_minutes = 5
max_cycles = 1
dump_window_ms = 3000
use_maker_orders = true
maker_fallback_to_taker = true
taker_fee_rate = 0.0625
max_spread_pct = 0.10
gtc_fill_timeout_ms = 30000
gtc_poll_interval_ms = 1000

[risk]
max_balance_pct_per_trade = 0.05
min_shares = 5
max_shares = 100
consecutive_loss_limit = 3
cooldown_minutes = 360
emergency_enabled = true
exit_before_expiry_minutes = 3

[paper]
enabled = true
starting_balance = 1000.0
simulate_fees = true
simulate_slippage = true
slippage_pct = 0.02
log_file = "paper_trades.jsonl"
record_data = true
data_dir = "data"
record_interval_ms = 1000
```
