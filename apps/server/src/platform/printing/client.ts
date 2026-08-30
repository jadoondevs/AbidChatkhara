import { Socket } from 'node:net';

export interface PrinterTarget {
  readonly host: string;
  readonly port: number;
}

export class PrintError extends Error {
  constructor(target: PrinterTarget, cause: string) {
    super(`failed to print to ${target.host}:${target.port} — ${cause}`);
    this.name = 'PrintError';
  }
}

/**
 * Send raw ESC/POS bytes to a network thermal printer over a plain TCP
 * socket — "server-side ESC/POS over raw TCP to network thermal
 * printers. No browser printing." (spec). Opens a connection, writes,
 * waits for the OS to confirm the write finished, and closes — no
 * response is expected back from the printer (ESC/POS printers are
 * generally fire-and-forget on this path).
 *
 * A print failure (printer off, wrong IP, network down) throws
 * `PrintError` rather than crashing the caller — a broken printer must
 * never stop the till from taking orders or closing bills; the caller
 * decides whether to surface the error to the cashier and let them
 * retry.
 */
export function sendToPrinter(target: PrinterTarget, data: Buffer, timeoutMs: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(new PrintError(target, `timed out after ${timeoutMs}ms`)));
    socket.once('error', (err) => finish(new PrintError(target, err.message)));

    socket.connect(target.port, target.host, () => {
      socket.write(data, (err) => {
        if (err) finish(new PrintError(target, err.message));
        else finish();
      });
    });
  });
}
