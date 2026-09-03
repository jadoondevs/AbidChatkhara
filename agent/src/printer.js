// The one place that touches the printer. Two ways to reach a BIXOLON:
// over the network (raw ESC/POS on a TCP port, usually 9100) or as a
// device path (a Windows printer share, or a Linux /dev node) written
// raw. Both bypass the Windows driver, which renders blank pages.
//
// Jobs are serialised through a single in-flight promise: the browser
// may fire a bill and a receipt close together, and interleaving two
// tickets' bytes on one connection would print garbage. This is the
// "queues jobs internally" the POS relies on.

import { createConnection } from 'node:net';
import { open } from 'node:fs/promises';
import { access, constants } from 'node:fs/promises';

const CONNECT_TIMEOUT_MS = 3000;

export class Printer {
  constructor(config) {
    this.config = config;
    this.tail = Promise.resolve();
  }

  /** Reachable right now? Prints nothing, uses no paper — safe to poll.
   * Network: can we open a socket to it. Device: does the path exist and
   * is it writable. */
  async healthy() {
    if (this.config.type === 'device') {
      try {
        await access(this.config.device, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    return new Promise((resolve) => {
      const socket = createConnection({ host: this.config.host, port: this.config.port });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  /** Send raw bytes, one job at a time. Resolves when the bytes are
   * flushed to the printer; rejects if they could not be. */
  print(bytes) {
    const run = () => (this.config.type === 'device' ? this.#writeDevice(bytes) : this.#writeNetwork(bytes));
    // Chain onto the tail so jobs never interleave, but a failed job must
    // not poison the queue for the next one.
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }

  async #writeDevice(bytes) {
    const handle = await open(this.config.device, 'a');
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  }

  #writeNetwork(bytes) {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.config.host, port: this.config.port });
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('printer connection timed out'));
      });
      socket.once('connect', () => {
        socket.write(bytes, (err) => {
          if (err) {
            socket.destroy();
            reject(err);
            return;
          }
          // end() flushes then closes; 'close' means the bytes are gone
          // to the printer.
          socket.end();
        });
      });
      socket.once('close', (hadError) => {
        if (!hadError) resolve();
      });
    });
  }
}
