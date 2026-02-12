import React from 'react';
import { Box, Text } from 'ink';
import { StrategyState } from '../../types/strategy.js';

interface StatusBarProps {
  state: StrategyState;
  market: string | null;
  secondsRemaining: number | null;
  mode: 'PAPER' | 'LIVE';
}

export const StatusBar: React.FC<StatusBarProps> = ({
  state,
  market,
  secondsRemaining,
  mode,
}) => {
  const stateColor =
    state === StrategyState.WATCHING ? 'yellow'
    : state === StrategyState.WAITING_FOR_HEDGE ? 'cyan'
    : state === StrategyState.COMPLETED ? 'green'
    : 'red'; // EMERGENCY_EXIT

  const timeStr = secondsRemaining != null
    ? `${Math.floor(secondsRemaining / 60)}:${String(Math.round(secondsRemaining % 60)).padStart(2, '0')}`
    : '--:--';

  // Extract readable market name: "btc-updown-15m-1770852600" → "btc-updown-15m"
  const marketShort = market
    ? market.replace(/-\d{10,}.*$/, '').slice(0, 20) || market.slice(0, 20)
    : 'none';

  return (
    <Box borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text>
        State: <Text color={stateColor} bold>{state}</Text>
        {' | '}Market: {marketShort}
        {' | '}Time: {timeStr}
        {' | '}Mode: <Text color={mode === 'PAPER' ? 'yellow' : 'red'} bold>{mode}</Text>
      </Text>
    </Box>
  );
};
