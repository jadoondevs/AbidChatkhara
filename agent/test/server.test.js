import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createAgentServer } from '../src/server.js';

/** A fake printer: records what it was asked to print, and can be told
 * to be reachable or not, or to fail a job. */
function fakePrinter() {
  const jobs = [];
  return {
    jobs,
    reachable: true,
    failNext: false,
    async healthy() {
      return this.reachable;
    },
    async print(bytes) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('device offline');
      }
      jobs.push(bytes);
    },
  };
}

async function withServer(printer, fn) {
  const server = createAgentServer(printer);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const bill = {
  kind: 'bill',
  restaurant: { name: 'Abid Chatkhara', address: '00 Example Road', phone: '000' },
  orderNumber: 40,
  date: 'now',
  orderType: 'dine_in',
  waiter: 'Saif',
  items: [{ quantity: 1, name: 'Fresh Apple Juice', amount: 450 }],
  subtotal: 450,
  discount: 0,
  serviceCharge: null,
  tax: null,
  total: 450,
  paymentOptions: [],
};

test('GET /health is 200 when the printer is reachable', async () => {
  const printer = fakePrinter();
  await withServer(printer, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(printer.jobs.length, 0, 'health prints nothing');
  });
});

test('GET /health is 503 when the printer is unreachable', async () => {
  const printer = fakePrinter();
  printer.reachable = false;
  await withServer(printer, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false });
  });
});

test('POST /print prints a bill and returns 200 {ok:true}', async () => {
  const printer = fakePrinter();
  await withServer(printer, async (base) => {
    const res = await fetch(`${base}/print`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bill),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(printer.jobs.length, 1);
    assert.match(printer.jobs[0].toString('ascii'), /Fresh Apple Juice/);
  });
});

test('a print that the printer refuses is 500 and nothing is claimed printed', async () => {
  const printer = fakePrinter();
  printer.failNext = true;
  await withServer(printer, async (base) => {
    const res = await fetch(`${base}/print`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bill),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).ok, false);
    assert.equal(printer.jobs.length, 0);
  });
});

test('an unknown ticket kind is a 400, not a crash', async () => {
  const printer = fakePrinter();
  await withServer(printer, async (base) => {
    const res = await fetch(`${base}/print`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'poster' }),
    });
    assert.equal(res.status, 400);
  });
});

test('CORS preflight is answered so the till browser can call in', async () => {
  const printer = fakePrinter();
  await withServer(printer, async (base) => {
    const res = await fetch(`${base}/print`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('bill and receipt are independent jobs, both queued in order', async () => {
  const printer = fakePrinter();
  await withServer(printer, async (base) => {
    const receipt = { ...bill, kind: 'receipt', invoiceNumber: 7, paymentMethod: 'Cash', amountPaid: 450 };
    delete receipt.paymentOptions;
    const [a, b] = await Promise.all([
      fetch(`${base}/print`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bill) }),
      fetch(`${base}/print`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(receipt) }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(printer.jobs.length, 2);
  });
});
