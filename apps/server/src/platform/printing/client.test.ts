import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PrintError, sendToPrinter } from './client.js';

describe('sendToPrinter', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  function startFakePrinter(onData: (chunks: Buffer[]) => void): Promise<{ host: string; port: number }> {
    return new Promise((resolve) => {
      server = createServer((socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (d) => chunks.push(d));
        socket.on('end', () => onData(chunks));
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address() as AddressInfo;
        resolve({ host: '127.0.0.1', port: address.port });
      });
    });
  }

  it('sends the exact bytes given to a listening printer', async () => {
    const received: Buffer[] = [];
    const target = await startFakePrinter((chunks) => received.push(...chunks));
    const payload = Buffer.from([0x1b, 0x40, 0x48, 0x69]); // ESC @ "Hi"

    await sendToPrinter(target, payload);
    // Give the server's 'end'/'data' handlers a tick to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(Buffer.concat(received)).toEqual(payload);
  });

  it('rejects with a PrintError when nothing is listening on the target port', async () => {
    // Port 1 is a privileged port almost certainly not listening in any
    // test environment, and connection refusal is fast and reliable.
    await expect(sendToPrinter({ host: '127.0.0.1', port: 1 }, Buffer.from('x'), 2000)).rejects.toBeInstanceOf(PrintError);
  });

  it('rejects with a PrintError on a connection timeout', async () => {
    // 10.255.255.1 is a non-routable address commonly used to force a
    // connect timeout rather than an immediate refusal.
    await expect(sendToPrinter({ host: '10.255.255.1', port: 9100 }, Buffer.from('x'), 100)).rejects.toBeInstanceOf(PrintError);
  }, 10_000);
});
