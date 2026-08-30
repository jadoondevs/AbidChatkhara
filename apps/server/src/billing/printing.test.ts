import { paisa } from '@pos/shared';
import { describe, expect, it } from 'vitest';
import { renderBillTicket, renderReceiptTicket, type BillTicketData, type ReceiptTicketData } from './printing.js';

function decode(buf: Buffer): string {
  return buf.toString('utf8');
}

describe('renderBillTicket', () => {
  const base: BillTicketData = {
    tableLabel: 'T4',
    orderType: 'dine_in',
    waiterName: 'Bilal',
    lines: [{ itemName: 'Karahi', qty: 2, modifierNames: ['Extra hot'], lineTotalMinor: paisa(1_000_00) }],
    subtotalMinor: paisa(1_000_00),
    discountMinor: paisa(0),
    discountReason: null,
    serviceChargeMinor: paisa(0),
    totalMinor: paisa(1_000_00),
    paymentOptions: [],
  };

  it('is clearly marked as a bill, not a receipt', () => {
    const text = decode(renderBillTicket(base));
    expect(text).toContain('BILL');
    expect(text).toContain('not a receipt');
    expect(text).not.toMatch(/Invoice #/);
  });

  it('includes the table, waiter, items, modifiers, and total', () => {
    const text = decode(renderBillTicket(base));
    expect(text).toContain('Table: T4');
    expect(text).toContain('Waiter: Bilal');
    expect(text).toContain('2 x Karahi');
    expect(text).toContain('+ Extra hot');
    expect(text).toContain('Rs 1,000.00');
  });

  it('omits the discount line entirely when there is no discount', () => {
    const text = decode(renderBillTicket(base));
    expect(text).not.toContain('Discount');
  });

  it('includes the discount, with reason, when present', () => {
    const withDiscount: BillTicketData = { ...base, discountMinor: paisa(100_00), discountReason: 'loyalty' };
    const text = decode(renderBillTicket(withDiscount));
    expect(text).toContain('Discount (loyalty)');
    expect(text).toContain('-Rs 100.00');
  });

  it('lists every payment option with its account details', () => {
    const withPayments: BillTicketData = {
      ...base,
      paymentOptions: [{ displayName: 'Easypaisa', accountTitle: 'Restaurant Pvt Ltd', accountNumber: '0300-1234567', bankName: null, instructionsLine: 'Send screenshot to till' }],
    };
    const text = decode(renderBillTicket(withPayments));
    expect(text).toContain('Easypaisa');
    expect(text).toContain('Restaurant Pvt Ltd');
    expect(text).toContain('0300-1234567');
    expect(text).toContain('Send screenshot to till');
  });

  it('ends with a cut command', () => {
    const buf = renderBillTicket(base);
    expect(buf.subarray(buf.length - 3)).toEqual(Buffer.from([0x1d, 0x56, 0x01]));
  });

  it('never kicks the drawer — that only ever happens on a receipt', () => {
    const buf = renderBillTicket(base);
    expect(buf.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(false);
  });
});

describe('renderReceiptTicket', () => {
  const base: ReceiptTicketData = {
    invoiceNo: 42,
    closedAt: '2026-01-05T12:00:00.000Z',
    tableLabel: 'T4',
    orderType: 'dine_in',
    waiterName: 'Bilal',
    lines: [{ itemName: 'Karahi', qty: 1, modifierNames: [], lineTotalMinor: paisa(500_00) }],
    subtotalMinor: paisa(500_00),
    discountMinor: paisa(0),
    taxMinor: paisa(0),
    serviceChargeMinor: paisa(0),
    roundingAdjustmentMinor: paisa(0),
    totalMinor: paisa(500_00),
    payments: [{ methodName: 'Cash', amountMinor: paisa(500_00), referenceNo: null }],
    cashPaymentReceived: true,
  };

  it('carries the invoice number', () => {
    const text = decode(renderReceiptTicket(base));
    expect(text).toContain('Invoice #42');
  });

  it('lists how it was paid', () => {
    const text = decode(renderReceiptTicket(base));
    expect(text).toContain('Cash');
    expect(text).toContain('Rs 500.00');
  });

  it('kicks the drawer only when a cash payment was recorded', () => {
    const withCash = renderReceiptTicket(base);
    expect(withCash.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(true);

    const withoutCash = renderReceiptTicket({ ...base, cashPaymentReceived: false, payments: [{ methodName: 'Easypaisa', amountMinor: paisa(500_00), referenceNo: 'TXN123' }] });
    expect(withoutCash.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(false);
  });

  it('shows a wallet/bank reference number when present', () => {
    const text = decode(
      renderReceiptTicket({ ...base, payments: [{ methodName: 'Easypaisa', amountMinor: paisa(500_00), referenceNo: 'TXN123' }] }),
    );
    expect(text).toContain('Easypaisa (TXN123)');
  });

  it('shows rounding only when non-zero', () => {
    const withoutRounding = decode(renderReceiptTicket(base));
    expect(withoutRounding).not.toContain('Rounding');

    const withRounding = decode(renderReceiptTicket({ ...base, roundingAdjustmentMinor: paisa(50) }));
    expect(withRounding).toContain('Rounding');
  });
});
