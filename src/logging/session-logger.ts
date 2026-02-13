import fs from 'node:fs';
import path from 'node:path';

export interface SessionLogger {
  sessionId: string;
  filePath: string;
  log: (message: string) => void;
  close: () => Promise<void>;
}

export interface SessionLoggerOptions {
  dir?: string;
  alsoConsole?: boolean;
  now?: Date;
}

function formatSessionId(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

export function createSessionLogger(
  name: string,
  options: SessionLoggerOptions = {},
): SessionLogger {
  const now = options.now ?? new Date();
  const sessionId = `${formatSessionId(now)}-${process.pid}`;
  const dir = options.dir ?? 'logs';
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${name}-${sessionId}.log`);
  const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
  const alsoConsole = options.alsoConsole ?? false;

  const log = (message: string): void => {
    const line = `[${new Date().toISOString()}] ${message}`;
    stream.write(`${line}\n`);
    if (alsoConsole) console.log(line);
  };

  const close = async (): Promise<void> => {
    if (stream.closed) return;
    await new Promise<void>((resolve) => {
      stream.end(resolve);
    });
  };

  return { sessionId, filePath, log, close };
}
