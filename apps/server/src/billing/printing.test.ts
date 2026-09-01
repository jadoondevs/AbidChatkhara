import { paisa } from '@pos/shared';
import { describe, expect, it } from 'vitest';
import { renderBillTicket, renderReceiptTicket, type BillTicketData, type ReceiptTicketData, type TicketBranding } from './printing.js';
import { defaultsFor } from '../settings/schema.js';

/** Defaults, i.e. a restaurant that has configured nothing — which must
 * still print a usable ticket. Tests about configured branding override
 * exactly the fields they are about. */
const branding: TicketBranding = { restaurant: defaultsFor('restaurant'), receipt: defaultsFor('receipt') };

function decode(buf: Buffer): string {
  return buf.toString('utf8');
}

describe('renderBillTicket', () => {
  const base: BillTicketData = {
    branding,
    orderId: 42,
    tableLabel: 'T4',
    orderType: 'dine_in',
    waiterName: 'Bilal',
    lines: [{ itemName: 'Karahi', qty: 2, modifierNames: ['Extra hot'], note: null, lineTotalMinor: paisa(1_000_00) }],
    subtotalMinor: paisa(1_000_00),
    discountMinor: paisa(0),
    discountReason: null,
    taxMinor: paisa(0),
    serviceChargeMinor: paisa(0),
    serviceChargeLabel: 'Service charge',
    roundingAdjustmentMinor: paisa(0),
    totalMinor: paisa(1_000_00),
    printedAt: '2026-08-31T12:00:00.000Z',
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
      paymentOptions: [
        {
          displayName: 'Easypaisa',
          accountTitle: 'Restaurant Pvt Ltd',
          accountNumber: '0300-1234567',
          bankName: null,
          instructionsLine: 'Send screenshot to till',
          accounts: [],
        },
      ],
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
    branding,
    orderId: 7,
    invoiceNo: 42,
    closedAt: '2026-01-05T12:00:00.000Z',
    tableLabel: 'T4',
    orderType: 'dine_in',
    waiterName: 'Bilal',
    lines: [{ itemName: 'Karahi', qty: 1, modifierNames: [], note: null, lineTotalMinor: paisa(500_00) }],
    subtotalMinor: paisa(500_00),
    discountMinor: paisa(0),
    taxMinor: paisa(0),
    serviceChargeMinor: paisa(0),
    serviceChargeLabel: 'Service charge',
    roundingAdjustmentMinor: paisa(0),
    totalMinor: paisa(500_00),
    payments: [{ methodName: 'Cash', amountMinor: paisa(500_00), referenceNo: null, accountLabel: null }],
    cashTenderedMinor: null,
    changeGivenMinor: null,
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

    const withoutCash = renderReceiptTicket({ ...base, cashPaymentReceived: false, payments: [{ methodName: 'Easypaisa', amountMinor: paisa(500_00), referenceNo: 'TXN123', accountLabel: null }] });
    expect(withoutCash.includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(false);
  });

  it('shows a wallet/bank reference number when present', () => {
    const text = decode(
      renderReceiptTicket({ ...base, payments: [{ methodName: 'Easypaisa', amountMinor: paisa(500_00), referenceNo: 'TXN123', accountLabel: null }] }),
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

describe('configurable branding', () => {
  const restaurant = {
    ...defaultsFor('restaurant'),
    name: 'Demo Karahi House',
    addressLine1: '12 Example Road',
    addressLine2: 'Nowhere Town',
    phone: '000-0000000',
    registrationLine: 'NTN 0000000-0',
  };

  const bill = (over: Partial<BillTicketData> = {}): string =>
    decode(
      renderBillTicket({
        branding,
        orderId: 42,
        tableLabel: 'T4',
        orderType: 'dine_in',
        waiterName: 'Bilal',
        lines: [{ itemName: 'Karahi', qty: 1, modifierNames: [], note: null, lineTotalMinor: paisa(500_00) }],
        subtotalMinor: paisa(500_00),
        discountMinor: paisa(0),
        discountReason: null,
        taxMinor: paisa(0),
        serviceChargeMinor: paisa(0),
        serviceChargeLabel: 'Service charge',
        roundingAdjustmentMinor: paisa(0),
        totalMinor: paisa(500_00),
        printedAt: '2026-08-31T12:00:00.000Z',
        paymentOptions: [],
        ...over,
      }),
    );

  it('prints the configured restaurant name, address, phone and registration line', () => {
    const text = bill({ branding: { restaurant, receipt: defaultsFor('receipt') } });
    expect(text).toContain('Demo Karahi House');
    expect(text).toContain('12 Example Road');
    expect(text).toContain('Nowhere Town');
    expect(text).toContain('000-0000000');
    expect(text).toContain('NTN 0000000-0');
  });

  it('hard-codes no restaurant identity: an unconfigured install prints none', () => {
    const text = bill();
    expect(text).toContain('BILL');
    expect(text).not.toContain('Demo Karahi House');
    // The one thing a blank configuration still prints is the default
    // thank-you, which names nobody.
    expect(text).toContain('Thank you');
  });

  it('honours the receipt toggles for address, phone, table, waiter and order number', () => {
    const receipt = {
      ...defaultsFor('receipt'),
      showAddress: false,
      showPhone: false,
      showTable: false,
      showWaiter: false,
      showOrderNumber: false,
    };
    const text = bill({ branding: { restaurant, receipt } });
    expect(text).toContain('Demo Karahi House');
    expect(text).not.toContain('12 Example Road');
    expect(text).not.toContain('000-0000000');
    expect(text).not.toContain('Table: T4');
    expect(text).not.toContain('Waiter: Bilal');
    expect(text).not.toContain('Order: #42');
  });

  it('uses the receipt header name in preference to the restaurant name', () => {
    const receipt = { ...defaultsFor('receipt'), headerName: 'Demo Karahi House — Branch 2' };
    const text = bill({ branding: { restaurant, receipt } });
    // The em dash an admin typed arrives as a hyphen: a thermal
    // printer decodes one byte against a code page, and the
    // alternative is two random glyphs where the dash should be.
    expect(text).toContain('Demo Karahi House - Branch 2');
  });

  it('prints the configured footer message and note', () => {
    const receipt = { ...defaultsFor('receipt'), footerMessage: 'Shukriya!', footerNote: 'Open 11am - 11pm' };
    const text = bill({ branding: { restaurant, receipt } });
    expect(text).toContain('Shukriya!');
    expect(text).toContain('Open 11am - 11pm');
  });

  it('shows the order type even when a bill has no table label', () => {
    const text = bill({ tableLabel: null });
    expect(text).not.toContain('Table:');
    expect(text).toContain('Order type: dine_in');
  });

  it('lists every configured account under its payment method', () => {
    const text = bill({
      paymentOptions: [
        {
          displayName: 'Easypaisa',
          accountTitle: null,
          accountNumber: null,
          bankName: null,
          instructionsLine: null,
          accounts: [
            { label: 'Counter wallet', accountNumber: '0000-0000000' },
            { label: 'Delivery wallet', accountNumber: '0000-1111111' },
          ],
        },
      ],
    });
    expect(text).toContain('Counter wallet: 0000-0000000');
    expect(text).toContain('Delivery wallet: 0000-1111111');
  });

  it('suppresses payment options entirely when the setting is off', () => {
    const receipt = { ...defaultsFor('receipt'), showPaymentAccounts: false };
    const text = bill({
      branding: { restaurant, receipt },
      paymentOptions: [
        { displayName: 'Easypaisa', accountTitle: null, accountNumber: null, bankName: null, instructionsLine: null, accounts: [] },
      ],
    });
    expect(text).not.toContain('Payment options');
  });

  it('shows cash tendered and change on a receipt, but never as a bill figure', () => {
    const text = decode(
      renderReceiptTicket({
        branding,
        orderId: 7,
        invoiceNo: 42,
        closedAt: '2026-01-05T12:00:00.000Z',
        tableLabel: null,
        orderType: 'takeaway',
        waiterName: null,
        lines: [{ itemName: 'Karahi', qty: 1, modifierNames: [], note: null, lineTotalMinor: paisa(1_800_00) }],
        subtotalMinor: paisa(1_800_00),
        discountMinor: paisa(0),
        taxMinor: paisa(0),
        serviceChargeMinor: paisa(0),
        serviceChargeLabel: 'Service charge',
        roundingAdjustmentMinor: paisa(0),
        totalMinor: paisa(1_800_00),
        payments: [{ methodName: 'Cash', amountMinor: paisa(1_800_00), referenceNo: null, accountLabel: null }],
        cashTenderedMinor: paisa(2_000_00),
        changeGivenMinor: paisa(200_00),
        cashPaymentReceived: true,
      }),
    );
    expect(text).toContain('Cash tendered');
    expect(text).toContain('Rs 2,000.00');
    expect(text).toContain('Change');
    expect(text).toContain('Rs 200.00');
    // The bill itself is still Rs 1,800 — change never inflates a total.
    expect(text).toContain('Rs 1,800.00');
  });

  it('names the account a non-cash payment landed in', () => {
    const text = decode(
      renderReceiptTicket({
        branding,
        orderId: 7,
        invoiceNo: 42,
        closedAt: '2026-01-05T12:00:00.000Z',
        tableLabel: null,
        orderType: 'takeaway',
        waiterName: null,
        lines: [{ itemName: 'Karahi', qty: 1, modifierNames: [], note: null, lineTotalMinor: paisa(500_00) }],
        subtotalMinor: paisa(500_00),
        discountMinor: paisa(0),
        taxMinor: paisa(0),
        serviceChargeMinor: paisa(0),
        serviceChargeLabel: 'Service charge',
        roundingAdjustmentMinor: paisa(0),
        totalMinor: paisa(500_00),
        payments: [{ methodName: 'Easypaisa', amountMinor: paisa(500_00), referenceNo: null, accountLabel: 'Counter wallet' }],
        cashTenderedMinor: null,
        changeGivenMinor: null,
        cashPaymentReceived: false,
      }),
    );
    expect(text).toContain('to Counter wallet');
  });
});
