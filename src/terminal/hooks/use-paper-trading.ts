import { useState, useEffect } from 'react';
import Decimal from 'decimal.js';
import type { PaperTrader } from '../../paper/paper-trader.js';
import type { CycleResult, Side } from '../../types/strategy.js';

interface PositionDisplay {
  side: Side;
  shares: Decimal;
  avgPrice: Decimal;
  roundSlug: string;
}

export interface PaperTradingData {
  balance: Decimal;
  pnl: Decimal;
  positions: PositionDisplay[];
  history: CycleResult[];
}

export function usePaperTrading(paperTrader: PaperTrader | null): PaperTradingData | null {
  const [balance, setBalance] = useState(new Decimal(0));
  const [pnl, setPnl] = useState(new Decimal(0));
  const [positions, setPositions] = useState<PositionDisplay[]>([]);
  const [history, setHistory] = useState<CycleResult[]>([]);

  useEffect(() => {
    if (!paperTrader) return;

    // Initialize
    setBalance(paperTrader.getBalance());
    setPnl(paperTrader.getPnL());

    const refresh = () => {
      setBalance(paperTrader.getBalance());
      setPnl(paperTrader.getPnL());
      setPositions(
        paperTrader.getPositions().map(p => ({
          side: p.side,
          shares: p.shares,
          avgPrice: p.avgPrice,
          roundSlug: p.roundSlug,
        })),
      );
      setHistory(paperTrader.getHistory());
    };

    paperTrader.on('trade', refresh);
    paperTrader.on('settled', refresh);

    // Poll every second for position updates
    const interval = setInterval(refresh, 1000);

    return () => {
      paperTrader.off('trade', refresh);
      paperTrader.off('settled', refresh);
      clearInterval(interval);
    };
  }, [paperTrader]);

  if (!paperTrader) return null;

  return { balance, pnl, positions, history };
}
