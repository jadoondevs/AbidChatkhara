import { sum, toRupeeInput, type Paisa } from '@pos/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../platform/db/types.js';
import { buildBillTicketData, buildReceiptTicketData, type BillTicketData, type ReceiptTicketData } from './printing.js';

/**
 * The payload the local ESC/POS print agent takes (see agent/).
 *
 * The agent prints raw bytes to the BIXOLON, bypassing the Windows
 * driver (which renders blank pages). It runs on the till at
 * http://127.0.0.1:7777 and the browser POSTs one of these to it. The
 * server builds the payload — not the browser — for one reason above
 * all: **account numbers are masked here**, so the full number never
 * leaves this process, let alone sits in a browser that a customer's
 * bill was printed from. The agent prints `accountNumber` verbatim.
 *
 * Money is sent in RUPEES as a number (the agent's contract: `450`, not
 * 45000), converted only through the money module's own `toRupeeInput`
 * — never bare `minor / 100`, per docs/decisions/001 and the
 * money-arithmetic guard.
 */

export interface AgentBillItem {
  quantity: number;
  name: string;
  /** The LINE total in rupees, not the unit price. */
  amount: number;
}

export interface AgentPaymentOption {
  bank: string;
  accountName: string;
  /** Already masked — `****7890`, never the full number. */
  accountNumber: string;
}

export interface AgentBillPayload {
  kind: 'bill';
  restaurant: { name: string; address: string; phone: string };
  orderNumber: number;
  date: string;
  orderType: string;
  waiter: string | null;
  items: AgentBillItem[];
  subtotal: number;
  discount: number;
  serviceCharge: number | null;
  tax: number | null;
  total: number;
  paymentOptions: AgentPaymentOption[];
}

export interface AgentReceiptPayload {
  kind: 'receipt';
  restaurant: { name: string; address: string; phone: string };
  orderNumber: number;
  invoiceNumber: number;
  date: string;
  orderType: string;
  waiter: string | null;
  items: AgentBillItem[];
  subtotal: number;
  discount: number;
  serviceCharge: number | null;
  tax: number | null;
  total: number;
  paymentMethod: string;
  amountPaid: number;
}

/** Rupees as a number, through the money module — `paisa(45000)` -> 450. */
function toRupees(minor: Paisa): number {
  return Number(toRupeeInput(minor));
}

/**
 * Keep only the last four digits: `03001234567` -> `****7890`.
 *
 * A bill sits on a table in front of whoever is paying, so the account
 * number a restaurant advertises to receive money is masked before it
 * is ever sent to something that prints it. A number too short to mask
 * meaningfully (four digits or fewer) is dropped to `****` rather than
 * printed in full — a four-digit "account number" is almost certainly a
 * placeholder, and printing it whole would defeat the point.
 */
export function maskAccountNumber(raw: string | null): string {
  if (!raw) return '';
  const digits = raw.replace(/\s+/g, '');
  if (digits.length <= 4) return '****';
  return `****${digits.slice(-4)}`;
}

/** A human date string for the ticket header, e.g. "9/3/2026, 11:50:46 PM". */
function ticketDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US');
}

/** The line as one printed name: the item, its sizes/add-ons, and any
 * kitchen note — the agent's item row is a single name, so what the
 * thermal renderer put on three lines is folded into one here. */
function lineName(line: BillTicketData['lines'][number]): string {
  const modifiers = line.modifierNames.length > 0 ? ` (${line.modifierNames.join(', ')})` : '';
  const note = line.note ? ` — ${line.note}` : '';
  return `${line.itemName}${modifiers}${note}`;
}

function items(data: BillTicketData | ReceiptTicketData): AgentBillItem[] {
  return data.lines.map((line) => ({ quantity: line.qty, name: lineName(line), amount: toRupees(line.lineTotalMinor) }));
}

/** A charge worth a line only when it is non-zero — the agent draws no
 * "Tax: Rs 0" row for a restaurant that charges none, matching how the
 * thermal and HTML renderers already suppress an empty charge. */
function nonZero(minor: Paisa): number | null {
  return minor === 0 ? null : toRupees(minor);
}

const restaurantOf = (data: BillTicketData | ReceiptTicketData) => ({
  name: data.branding.restaurant.name,
  address: [data.branding.restaurant.addressLine1, data.branding.restaurant.addressLine2].filter((part) => part.trim()).join(', '),
  phone: data.branding.restaurant.phone,
});

export async function buildAgentBillPayload(db: Kysely<Database>, orderId: number): Promise<AgentBillPayload> {
  const data = await buildBillTicketData(db, orderId);

  // Every advertised account, flattened and masked. Honours the same
  // showPaymentAccounts switch the printed renderers do — an account is
  // only here because it is active and marked to print (migration 0019),
  // and the whole block disappears when the restaurant hides it.
  const paymentOptions: AgentPaymentOption[] = data.branding.receipt.showPaymentAccounts
    ? data.paymentOptions.flatMap((option) =>
        option.accounts.map((account) => ({
          bank: account.bankName ?? option.displayName,
          accountName: account.accountTitle ?? account.label,
          accountNumber: maskAccountNumber(account.accountNumber),
        })),
      )
    : [];

  return {
    kind: 'bill',
    restaurant: restaurantOf(data),
    orderNumber: data.orderId,
    date: ticketDate(data.printedAt),
    orderType: data.orderType,
    waiter: data.waiterName,
    items: items(data),
    subtotal: toRupees(data.subtotalMinor),
    discount: toRupees(data.discountMinor),
    serviceCharge: nonZero(data.serviceChargeMinor),
    tax: nonZero(data.taxMinor),
    total: toRupees(data.totalMinor),
    paymentOptions,
  };
}

export async function buildAgentReceiptPayload(db: Kysely<Database>, orderId: number): Promise<AgentReceiptPayload> {
  const data = await buildReceiptTicketData(db, orderId);

  // The method NAMES are the payment's own snapshot (migration 0019), so
  // a receipt reprinted after a method was renamed still says what the
  // customer paid with at the time.
  const methodNames = [...new Set(data.payments.map((payment) => payment.methodName))].join(', ');
  const amountPaid = sum(data.payments.map((payment) => payment.amountMinor));

  return {
    kind: 'receipt',
    restaurant: restaurantOf(data),
    orderNumber: data.orderId,
    invoiceNumber: data.invoiceNo,
    date: ticketDate(data.closedAt),
    orderType: data.orderType,
    waiter: data.waiterName,
    items: items(data),
    subtotal: toRupees(data.subtotalMinor),
    discount: toRupees(data.discountMinor),
    serviceCharge: nonZero(data.serviceChargeMinor),
    tax: nonZero(data.taxMinor),
    total: toRupees(data.totalMinor),
    paymentMethod: methodNames,
    amountPaid: toRupees(amountPaid),
  };
}
