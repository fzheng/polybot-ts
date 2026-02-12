import React from 'react';
import { Box, Text } from 'ink';
import Decimal from 'decimal.js';
import type { Side } from '../../types/strategy.js';

interface PositionDisplay {
  side: Side;
  shares: Decimal;
  avgPrice: Decimal;
  roundSlug: string;
}

interface PositionsPanelProps {
  positions: PositionDisplay[];
  balance: Decimal | null;
  pnl: Decimal | null;
  isPaper: boolean;
}

export const PositionsPanel: React.FC<PositionsPanelProps> = ({
  positions,
  balance,
  pnl,
  isPaper,
}) => {
  const pnlColor = pnl ? (pnl.greaterThan(0) ? 'green' : pnl.lessThan(0) ? 'red' : 'yellow') : 'gray';

  return (
    <Box borderStyle="single" borderColor="magenta" flexDirection="column" paddingX={1}>
      <Text bold underline>Positions</Text>
      {isPaper && balance && (
        <Text>
          Balance: ${balance.toFixed(2)}{' '}
          <Text color={pnlColor}>
            ({pnl && pnl.greaterThanOrEqualTo(0) ? '+' : ''}{pnl?.toFixed(2) ?? '0.00'})
          </Text>
        </Text>
      )}
      {positions.length === 0 ? (
        <Text color="gray">  No open positions</Text>
      ) : (
        positions.map((pos, i) => (
          <Text key={i}>
            {'  '}
            <Text color={pos.side === 'UP' ? 'green' : 'red'}>{pos.side}</Text>
            : {pos.shares.toString()} @ ${pos.avgPrice.toFixed(4)}
          </Text>
        ))
      )}
    </Box>
  );
};
