import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render, renderBill, renderReceipt, renderTest } from '../src/escpos.js';

const ESC_INIT = Buffer.from([0x1b, 0x40]);

const bill = {
  kind: 'bill',
  restaurant: { name: 'Abid Chatkhara', address: '00 Example Road', phone: '000-0000000' },
  orderNumber: 40,
  date: '9/3/2026, 11:50:46 PM',
  orderType: 'dine_in',
  waiter: 'Saif',
  items: [{ quantity: 1, name: 'Fresh Apple Juice', amount: 450 }],
  subtotal: 450,
  discount: 0,
  serviceCharge: null,
  tax: null,
  total: 450,
  paymentOptions: [{ bank: 'HBL', accountName: 'abid', accountNumber: '****7890' }],
};

test('a bill initialises the printer and contains its own text', () => {
  const bytes = renderBill(bill);
  assert.ok(bytes.subarray(0, 2).equals(ESC_INIT), 'starts with ESC @');
  const asText = bytes.toString('ascii');
  assert.match(asText, /Abid Chatkhara/);
  assert.match(asText, /1 x Fresh Apple Juice/);
  assert.match(asText, /Rs 450/);
  assert.match(asText, /TOTAL/);
  // The masked number is printed verbatim — the agent never sees a full one.
  assert.match(asText, /\*\*\*\*7890/);
});

test('a receipt prints the invoice, the payment method and kicks the drawer', () => {
  const receipt = {
    kind: 'receipt',
    restaurant: bill.restaurant,
    orderNumber: 40,
    invoiceNumber: 7,
    date: bill.date,
    orderType: 'takeaway',
    waiter: 'Saif',
    items: bill.items,
    subtotal: 450,
    discount: 0,
    serviceCharge: null,
    tax: null,
    total: 450,
    paymentMethod: 'Cash',
    amountPaid: 450,
  };
  const bytes = renderReceipt(receipt);
  const asText = bytes.toString('ascii');
  assert.match(asText, /RECEIPT/);
  assert.match(asText, /Invoice/);
  assert.match(asText, /#7/);
  assert.match(asText, /Paid by/);
  assert.match(asText, /Cash/);
  // ESC p 0 — the cash-drawer kick — is present.
  assert.ok(bytes.includes(Buffer.from([0x1b, 0x70, 0x00])), 'kicks the drawer');
});

test('a bill does NOT kick the drawer (no money has changed hands yet)', () => {
  const bytes = renderBill(bill);
  assert.ok(!bytes.includes(Buffer.from([0x1b, 0x70, 0x00])));
});

test('the test strip has an ordinary and an emphasised block', () => {
  const bytes = renderTest(5);
  const asText = bytes.toString('ascii');
  assert.match(asText, /Ordinary text/);
  assert.match(asText, /Emphasised text/);
  // ESC E 1 (emphasis on) appears for the heavy block.
  assert.ok(bytes.includes(Buffer.from([0x1b, 0x45, 0x01])));
});

test('an unknown kind throws rather than printing nonsense', () => {
  assert.throws(() => render({ kind: 'banner' }), /unknown ticket kind/);
});

test('a very long item name wraps instead of running off the paper', () => {
  const bytes = renderBill({
    ...bill,
    items: [{ quantity: 2, name: 'Chicken Karahi Makhni Boneless Extra Spicy Family Platter', amount: 5200 }],
  });
  // Only the item text lines are measured — other lines carry ESC/GS
  // command bytes (align, emphasis) that have no width on paper but
  // would inflate a naive character count.
  const itemLines = bytes
    .toString('ascii')
    .split('\n')
    .filter((l) => /Chicken|Makhni|Boneless|Extra|Spicy|Family|Platter/.test(l));
  assert.ok(itemLines.length >= 2, 'the long name wrapped onto more than one line');
  assert.ok(
    itemLines.every((l) => l.length <= 42),
    `no item line exceeds 42 columns; got ${JSON.stringify(itemLines)}`,
  );
});
