import React from 'react';
import { Box, Text } from 'ink';

interface LogEntry {
  message: string;
  timestamp: Date;
  level: string;
}

interface LogsPanelProps {
  logs: LogEntry[];
  messages: string[];
}

export const LogsPanel: React.FC<LogsPanelProps> = ({ logs, messages }) => {
  // Merge strategy logs and command messages, show most recent
  const combined = [
    ...messages.map(m => ({ message: m, timestamp: new Date(), level: 'info' })),
    ...logs,
  ]
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(-10);

  const levelColor = (level: string): string => {
    switch (level) {
      case 'error': return 'red';
      case 'warn': return 'yellow';
      case 'debug': return 'gray';
      default: return 'white';
    }
  };

  return (
    <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1}>
      <Text bold underline>Log</Text>
      {combined.map((entry, i) => {
        const ts = entry.timestamp.toTimeString().slice(0, 8);
        return (
          <Text key={i} color={levelColor(entry.level)}>
            [{ts}] {entry.message}
          </Text>
        );
      })}
    </Box>
  );
};
