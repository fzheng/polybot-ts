import React from 'react';
import { Box, Text } from 'ink';

interface LogEntry {
  message: string;
  timestamp: Date;
  level: string;
}

interface LogsPanelProps {
  logs: LogEntry[];
  messages: LogEntry[];
}

function sanitizeLine(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[^\x20-\x7E]/g, '');
}

export const LogsPanel: React.FC<LogsPanelProps> = ({ logs, messages }) => {
  // Merge strategy logs and command messages, show most recent.
  const combined = [
    ...messages,
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
          <Text key={`${entry.timestamp.getTime()}-${i}`} color={levelColor(entry.level)}>
            [{ts}] {sanitizeLine(entry.message)}
          </Text>
        );
      })}
    </Box>
  );
};
