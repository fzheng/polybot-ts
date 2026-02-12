import { useState, useEffect } from 'react';
import Decimal from 'decimal.js';
import { StrategyState, Side } from '../../types/strategy.js';
import type { EnhancedDipArbStrategy } from '../../strategy/enhanced-dip-arb.js';

interface LogEntry {
  message: string;
  timestamp: Date;
  level: string;
}

export interface StrategyStateData {
  state: StrategyState;
  totalProfit: Decimal;
  cyclesCompleted: number;
  emergencyExits: number;
  leg1Side: Side | null;
  leg1Price: Decimal | null;
  logs: LogEntry[];
}

export function useStrategyState(strategy: EnhancedDipArbStrategy): StrategyStateData {
  const [state, setState] = useState<StrategyState>(StrategyState.WATCHING);
  const [totalProfit, setTotalProfit] = useState(new Decimal(0));
  const [cyclesCompleted, setCyclesCompleted] = useState(0);
  const [emergencyExits, setEmergencyExits] = useState(0);
  const [leg1Side, setLeg1Side] = useState<Side | null>(null);
  const [leg1Price, setLeg1Price] = useState<Decimal | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    const handleStateChange = (newState: StrategyState) => setState(newState);

    const handleLog = (entry: LogEntry) => {
      // Filter out debug-level noise from the TUI
      if (entry.level === 'debug') return;
      setLogs(prev => [...prev.slice(-99), entry]);
    };

    const handleLeg1 = (leg: any) => {
      setLeg1Side(leg.side);
      setLeg1Price(leg.price);
    };

    const handleCycleComplete = () => {
      const stats = strategy.getStats();
      setTotalProfit(stats.totalProfit);
      setCyclesCompleted(stats.cyclesCompleted);
      setEmergencyExits(stats.emergencyExits);
      setLeg1Side(null);
      setLeg1Price(null);
    };

    strategy.on('stateChange', handleStateChange);
    strategy.on('log', handleLog);
    strategy.on('leg1Executed', handleLeg1);
    strategy.on('cycleComplete', handleCycleComplete);

    return () => {
      strategy.off('stateChange', handleStateChange);
      strategy.off('log', handleLog);
      strategy.off('leg1Executed', handleLeg1);
      strategy.off('cycleComplete', handleCycleComplete);
    };
  }, [strategy]);

  return {
    state,
    totalProfit,
    cyclesCompleted,
    emergencyExits,
    leg1Side,
    leg1Price,
    logs,
  };
}
