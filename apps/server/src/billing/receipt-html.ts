import { format } from '@pos/shared';
import type { BillTicketData, ReceiptTicketData, TicketBranding, TicketLine } from './printing.js';

/**
 * The same tickets `printing.ts` renders as ESC/POS bytes, rendered as
 * a self-contained HTML page for the browser's own print dialog.
 *
 * This is the FALLBACK path: when no thermal printer is configured or
 * the configured one cannot be reached, the server hands the till this
 * HTML and the browser prints it — which is how a cashier reaches
 * "Microsoft Print to PDF" or any other Windows printer without the POS
 * needing to know those printers exist.
 *
 * It is a second RENDERER, never a second calculation. Both renderers
 * are pure functions of the same `BillTicketData`/`ReceiptTicketData`
 * that `buildBillTicketData`/`buildReceiptTicketData` produce, so a
 * total cannot differ between the two print paths — there is only one
 * place the totals come from, and neither renderer does arithmetic.
 *
 * The page is deliberately styled as an 80mm receipt rather than an A4
 * document: it is the same ticket, and a cashier who prints it to PDF
 * should recognise it as the receipt they would otherwise have handed
 * over.
 */

const RECEIPT_WIDTH_MM = 80;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Show enough of an account number to identify which account this was,
 * and no more — `0000-1111111` prints as `••••1111`.
 *
 * A receipt is handed to a customer and then left on a table, so the
 * full number of an account the restaurant receives money into has no
 * business on it. Short identifiers (under 5 characters) are masked
 * entirely rather than revealed by a "last four" that would be the
 * whole thing.
 */
export function maskAccountNumber(accountNumber: string | null): string | null {
  if (accountNumber === null) return null;
  const trimmed = accountNumber.trim();
  if (trimmed === '') return null;
  const visible = trimmed.slice(-4);
  return trimmed.length <= 4 ? '•'.repeat(trimmed.length) : `••••${visible}`;
}

function row(left: string, right: string, className = ''): string {
  return `<div class="row${className ? ` ${className}` : ''}"><span>${escapeHtml(left)}</span><span>${escapeHtml(right)}</span></div>`;
}

function itemRows(lines: readonly TicketLine[]): string {
  return lines
    .map((line) => {
      const modifiers = line.modifierNames.length
        ? `<div class="modifiers">${escapeHtml(line.modifierNames.join(', '))}</div>`
        : '';
      // The kitchen instruction prints on the customer's copy too: it
      // is what they asked for, and the thing they will point at if
      // what arrived was not it.
      const note = line.note ? `<div class="modifiers">${escapeHtml(line.note)}</div>` : '';
      return `<div class="item">${row(`${line.qty} × ${line.itemName}`, format(line.lineTotalMinor))}${modifiers}${note}</div>`;
    })
    .join('');
}

function header(branding: TicketBranding, title: string, subtitle: string | null): string {
  const { restaurant, receipt } = branding;
  const name = receipt.headerName.trim() || restaurant.name.trim();
  const parts: string[] = [];
  if (name) parts.push(`<div class="name">${escapeHtml(name)}</div>`);
  if (receipt.showAddress) {
    if (restaurant.addressLine1.trim()) parts.push(`<div>${escapeHtml(restaurant.addressLine1.trim())}</div>`);
    if (restaurant.addressLine2.trim()) parts.push(`<div>${escapeHtml(restaurant.addressLine2.trim())}</div>`);
  }
  if (receipt.showPhone && restaurant.phone.trim()) parts.push(`<div>${escapeHtml(restaurant.phone.trim())}</div>`);
  if (restaurant.registrationLine.trim()) parts.push(`<div>${escapeHtml(restaurant.registrationLine.trim())}</div>`);
  if (receipt.headerNote.trim()) parts.push(`<div>${escapeHtml(receipt.headerNote.trim())}</div>`);

  parts.push(`<div class="title">${escapeHtml(title)}</div>`);
  if (subtitle) parts.push(`<div>${escapeHtml(subtitle)}</div>`);
  return `<header>${parts.join('')}</header>`;
}

function footer(branding: TicketBranding): string {
  const { receipt } = branding;
  const parts: string[] = [];
  if (receipt.footerMessage.trim()) parts.push(`<div>${escapeHtml(receipt.footerMessage.trim())}</div>`);
  if (receipt.footerNote.trim()) parts.push(`<div>${escapeHtml(receipt.footerNote.trim())}</div>`);
  return parts.length ? `<footer>${parts.join('')}</footer>` : '';
}

/**
 * `@page { size: 80mm auto }` asks the browser for a receipt-shaped
 * page, which Windows honours for roll printers and ignores gracefully
 * for A4 — printing the ticket at the top of the sheet rather than
 * failing.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${RECEIPT_WIDTH_MM}mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Courier New", Courier, monospace;
    font-size: 12px;
    line-height: 1.35;
    color: #000;
    background: #fff;
    width: ${RECEIPT_WIDTH_MM - 8}mm;
  }
  header, footer { text-align: center; }
  header { margin-bottom: 6px; }
  footer { margin-top: 10px; }
  .name { font-size: 16px; font-weight: 700; }
  .title { font-size: 15px; font-weight: 700; margin-top: 6px; letter-spacing: 0.08em; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row span:last-child { white-space: nowrap; }
  .item { margin-bottom: 2px; }
  .modifiers { padding-left: 10px; font-size: 11px; }
  .grand { font-weight: 700; font-size: 14px; margin-top: 2px; }
  .meta div { display: flex; justify-content: space-between; gap: 8px; }
  .note { font-size: 11px; padding-left: 10px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderBillHtml(data: BillTicketData): string {
  const { receipt } = data.branding;
  const meta: string[] = [];
  if (receipt.showOrderNumber) meta.push(row('Order', `#${data.orderId}`));
  meta.push(row('Date', new Date(data.printedAt).toLocaleString()));
  if (receipt.showTable && data.tableLabel) meta.push(row('Table', data.tableLabel));
  meta.push(row('Order type', data.orderType));
  if (receipt.showWaiter && data.waiterName) meta.push(row('Waiter', data.waiterName));

  const totals: string[] = [row('Subtotal', format(data.subtotalMinor))];
  if (data.discountMinor > 0) {
    totals.push(row(`Discount${data.discountReason ? ` (${data.discountReason})` : ''}`, `-${format(data.discountMinor)}`));
  }
  if (data.taxMinor > 0) totals.push(row('Tax', format(data.taxMinor)));
  if (data.serviceChargeMinor > 0) totals.push(row(data.serviceChargeLabel, format(data.serviceChargeMinor)));
  if (data.roundingAdjustmentMinor !== 0) totals.push(row('Rounding', format(data.roundingAdjustmentMinor)));
  totals.push(row('TOTAL', format(data.totalMinor), 'grand'));

  let paymentOptions = '';
  if (receipt.showPaymentAccounts && data.paymentOptions.length > 0) {
    const blocks = data.paymentOptions.map((option) => {
      const details: string[] = [];
      if (option.accountTitle) details.push(escapeHtml(option.accountTitle));
      if (option.accountNumber) details.push(escapeHtml(maskAccountNumber(option.accountNumber) ?? ''));
      if (option.bankName) details.push(escapeHtml(option.bankName));
      if (option.instructionsLine) details.push(escapeHtml(option.instructionsLine));
      for (const account of option.accounts) {
        const masked = maskAccountNumber(account.accountNumber);
        details.push(escapeHtml(`${account.label}${masked ? `: ${masked}` : ''}`));
      }
      return `<div><strong>${escapeHtml(option.displayName)}</strong>${details.map((d) => `<div class="note">${d}</div>`).join('')}</div>`;
    });
    paymentOptions = `<hr><div>Payment options:</div>${blocks.join('')}`;
  }

  return page(
    `Bill — order ${data.orderId}`,
    [
      header(data.branding, 'BILL', '(not a receipt)'),
      '<hr>',
      `<div class="meta">${meta.join('')}</div>`,
      '<hr>',
      itemRows(data.lines),
      '<hr>',
      totals.join(''),
      paymentOptions,
      footer(data.branding),
    ].join('\n'),
  );
}

export function renderReceiptHtml(data: ReceiptTicketData): string {
  const { receipt } = data.branding;
  const meta: string[] = [row('Date', new Date(data.closedAt).toLocaleString())];
  if (receipt.showOrderNumber) meta.push(row('Order', `#${data.orderId}`));
  if (receipt.showTable && data.tableLabel) meta.push(row('Table', data.tableLabel));
  meta.push(row('Order type', data.orderType));
  if (receipt.showWaiter && data.waiterName) meta.push(row('Waiter', data.waiterName));

  const totals: string[] = [row('Subtotal', format(data.subtotalMinor))];
  if (data.discountMinor > 0) totals.push(row('Discount', `-${format(data.discountMinor)}`));
  if (data.taxMinor > 0) totals.push(row('Tax', format(data.taxMinor)));
  if (data.serviceChargeMinor > 0) totals.push(row(data.serviceChargeLabel, format(data.serviceChargeMinor)));
  if (data.roundingAdjustmentMinor !== 0) totals.push(row('Rounding', format(data.roundingAdjustmentMinor)));
  totals.push(row('TOTAL', format(data.totalMinor), 'grand'));

  const payments = data.payments.map((payment) => {
    const label = `${payment.methodName}${payment.referenceNo ? ` (${payment.referenceNo})` : ''}`;
    const account = payment.accountLabel ? `<div class="note">to ${escapeHtml(payment.accountLabel)}</div>` : '';
    return `<div>${row(label, format(payment.amountMinor))}${account}</div>`;
  });

  const cash: string[] = [];
  if (data.cashTenderedMinor !== null && data.changeGivenMinor !== null && data.changeGivenMinor > 0) {
    cash.push(row('Cash tendered', format(data.cashTenderedMinor)));
    cash.push(row('Change', format(data.changeGivenMinor)));
  }

  return page(
    `Receipt — invoice ${data.invoiceNo}`,
    [
      header(data.branding, 'RECEIPT', `Invoice #${data.invoiceNo}`),
      '<hr>',
      `<div class="meta">${meta.join('')}</div>`,
      '<hr>',
      itemRows(data.lines),
      '<hr>',
      totals.join(''),
      '<hr>',
      '<div>Paid via:</div>',
      payments.join(''),
      cash.join(''),
      footer(data.branding),
    ].join('\n'),
  );
}
