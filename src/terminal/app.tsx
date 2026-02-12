import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { PricePanel } from './components/PricePanel.js';
import { PositionsPanel } from './components/PositionsPanel.js';
import { HistoryPanel } from './components/HistoryPanel.js';
import { LogsPanel } from './components/LogsPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { useMarketData } from './hooks/use-market-data.js';
import { useStrategyState } from './hooks/use-strategy-state.js';
import { usePaperTrading } from './hooks/use-paper-trading.js';
import type { EnhancedDipArbStrategy } from '../strategy/enhanced-dip-arb.js';
import type { PaperTrader } from '../paper/paper-trader.js';
import type { BotConfig } from '../config.js';

interface AppProps {
  config: BotConfig;
  strategy: EnhancedDipArbStrategy;
  paperTrader: PaperTrader | null;
}

export const App: React.FC<AppProps> = ({ config, strategy, paperTrader }) => {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<string[]>([
    'PolyBot v2.0 (TypeScript + poly-sdk)',
    config.paper.enabled ? `PAPER MODE — Balance: $${config.paper.startingBalance}` : 'LIVE MODE',
    'Type "help" for commands',
  ]);

  const market = useMarketData(strategy);
  const strat = useStrategyState(strategy);
  const paper = usePaperTrading(paperTrader);

  const addMessage = useCallback((msg: string) => {
    setMessages(prev => [...prev.slice(-49), msg]);
  }, []);

  const handleSubmit = useCallback((cmd: string) => {
    const parts = cmd.trim().toLowerCase().split(/\s+/);
    const command = parts[0];

    switch (command) {
      case 'help':
        addMessage('Commands: help, status, stats, params, balance, positions, history, quit');
        break;
      case 'status':
        addMessage(`State: ${strat.state} | Round: ${market.currentMarket ?? 'none'}`);
        if (strat.leg1Side) {
          addMessage(`  Leg 1: ${strat.leg1Side} @ $${strat.leg1Price?.toFixed(4)}`);
        }
        break;
      case 'stats':
        const s = strat;
        addMessage(
          `Cycles: ${s.cyclesCompleted} | Profit: $${s.totalProfit.toFixed(4)} | ` +
          `Emergency Exits: ${s.emergencyExits}`,
        );
        break;
      case 'balance':
        if (paper) {
          addMessage(`Balance: $${paper.balance.toFixed(4)} | P&L: $${paper.pnl.toFixed(4)}`);
        } else {
          addMessage('Balance: N/A (live mode)');
        }
        break;
      case 'quit':
      case 'exit':
        exit();
        break;
      default:
        if (command) addMessage(`Unknown command: ${command}`);
    }
    setInput('');
  }, [strat, market, paper, addMessage, exit]);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">PolyBot v2.0</Text>
        <Text> — {config.trading.assets.join('/')} {config.trading.duration} Dip Arb with Maker Orders</Text>
      </Box>

      {/* Top row: Prices + Positions side-by-side */}
      <Box flexDirection="row">
        <Box width="50%">
          <PricePanel
            upAsk={market.upAsk}
            upBid={market.upBid}
            downAsk={market.downAsk}
            downBid={market.downBid}
            sum={market.sum}
          />
        </Box>
        <Box flexGrow={1}>
          <PositionsPanel
            positions={paper?.positions ?? []}
            balance={paper?.balance ?? null}
            pnl={paper?.pnl ?? null}
            isPaper={config.paper.enabled}
          />
        </Box>
      </Box>

      {/* Log — full width below */}
      <LogsPanel logs={strat.logs} messages={messages} />

      {/* History — full width below */}
      <HistoryPanel history={paper?.history ?? []} />

      {/* Status bar */}
      <StatusBar
        state={strat.state}
        market={market.currentMarket}
        secondsRemaining={market.secondsRemaining}
        mode={config.paper.enabled ? 'PAPER' : 'LIVE'}
      />

      {/* Command input */}
      <Box borderStyle="single" borderColor="green" paddingX={1}>
        <Text color="green">{"> "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
};
