import React from 'react';
import { Box, Text } from 'ink';
import type { CycleResult } from '../../types/strategy.js';

interface HistoryPanelProps {
  history: CycleResult[];
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({ history }) => {
  const recent = history.slice(-8);

  return (
    <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text bold underline>History</Text>
      {recent.length === 0 ? (
        <Text color="gray">  No completed cycles yet</Text>
      ) : (
        recent.map((cycle, i) => {
          const profitColor = cycle.profit.greaterThan(0)
            ? 'green'
            : cycle.profit.lessThan(0)
              ? 'red'
              : 'yellow';
          const statusIcon = cycle.status === 'completed'
            ? '+'
            : cycle.status === 'emergency_exit'
              ? '!'
              : 'x';

          return (
            <Text key={i}>
              {'  '}{statusIcon} {cycle.roundSlug.slice(-10)}{' '}
              <Text color={profitColor}>
                {cycle.profit.greaterThanOrEqualTo(0) ? '+' : ''}
                ${cycle.profit.toFixed(4)}
              </Text>
              {' '}({cycle.status})
            </Text>
          );
        })
      )}
    </Box>
  );
};
