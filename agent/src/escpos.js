// Turn a ticket payload (the POS's agent contract) into raw ESC/POS
// bytes for an 80mm thermal printer. Pure — a function of its input,
// no I/O — so it is unit-testable without a printer.
//
// The byte sequences here are the same small, deliberate set the POS's
// own renderer uses (see apps/server/src/platform/printing/escpos.ts):
// initialise, Font A, code page, emphasis on/off, double-size on/off,
// feed, cut, drawer. Nothing speculative is emitted.

const ESC = 0x1b;
const GS = 0x1d;
const WIDTH = 42; // characters — 80mm at Font A

const cmd = (...bytes) => Buffer.from(bytes);
const text = (s) => Buffer.from(s, 'ascii');

/** Right-justify `right` against `left` within `width` columns. */
function twoCol(left, right, width = WIDTH) {
  const l = String(left);
  const r = String(right);
  const gap = Math.max(1, width - l.length - r.length);
  return l + ' '.repeat(gap) + r;
}

/** Wrap a long string to the paper width, so an item name never runs off
 * the edge or pushes its amount out of sight. */
function wrap(s, width = WIDTH) {
  const words = String(s).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if ((line + ' ' + word).length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const rupees = (n) => `Rs ${Number(n).toLocaleString('en-US')}`;

class Builder {
  constructor(densityLevel = 0) {
    this.parts = [];
    // Initialise, select Font A and code page 0 (CP437) — the same
    // honest baseline the POS renderer sets, so ordinary text is dark
    // enough to read without emphasising every line.
    this.raw(cmd(ESC, 0x40)); // ESC @  — initialise
    this.raw(cmd(ESC, 0x4d, 0x00)); // ESC M 0 — Font A
    this.raw(cmd(ESC, 0x74, 0x00)); // ESC t 0 — code page
    if (densityLevel >= 1 && densityLevel <= 8) {
      // GS ( K  print-density (length-prefixed, so a printer that does
      // not implement it skips it cleanly). fn=49, m = level.
      this.raw(cmd(GS, 0x28, 0x4b, 0x02, 0x00, 0x31, densityLevel));
    }
  }
  raw(buf) {
    this.parts.push(buf);
    return this;
  }
  align(a) {
    return this.raw(cmd(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0));
  }
  bold(on) {
    return this.raw(cmd(ESC, 0x45, on ? 1 : 0));
  }
  double(on) {
    return this.raw(cmd(GS, 0x21, on ? 0x11 : 0x00));
  }
  line(s = '') {
    return this.raw(text(s)).raw(cmd(0x0a));
  }
  rule() {
    return this.line('-'.repeat(WIDTH));
  }
  feed(n) {
    return this.raw(cmd(ESC, 0x64, n)); // ESC d n
  }
  cut() {
    return this.raw(cmd(GS, 0x56, 0x42, 0x00)); // GS V 66 0 — feed & partial cut
  }
  drawer() {
    return this.raw(cmd(ESC, 0x70, 0x00, 0x19, 0xfa)); // ESC p 0 — kick drawer
  }
  build() {
    return Buffer.concat(this.parts);
  }
}

function header(b, restaurant) {
  b.align('center');
  if (restaurant?.name) b.bold(true).double(true).line(restaurant.name).double(false).bold(false);
  if (restaurant?.address) b.line(restaurant.address);
  if (restaurant?.phone) b.line(restaurant.phone);
  b.align('left').rule();
}

function infoRows(b, payload) {
  b.line(twoCol('Order', `#${payload.orderNumber}`));
  if (payload.invoiceNumber !== undefined) b.line(twoCol('Invoice', `#${payload.invoiceNumber}`));
  if (payload.date) b.line(twoCol('Date', payload.date));
  if (payload.orderType) b.line(twoCol('Type', String(payload.orderType).replace(/_/g, ' ')));
  if (payload.waiter) b.line(twoCol('Served by', payload.waiter));
  b.rule();
}

function items(b, list) {
  for (const item of list ?? []) {
    const qtyName = `${item.quantity} x ${item.name}`;
    const amount = rupees(item.amount);
    const wrapped = wrap(qtyName, WIDTH - amount.length - 1);
    // First line carries the amount on the right; continuation lines are
    // just the wrapped name.
    b.line(twoCol(wrapped[0], amount));
    for (const cont of wrapped.slice(1)) b.line(`  ${cont}`);
  }
  b.rule();
}

function totals(b, payload) {
  b.line(twoCol('Subtotal', rupees(payload.subtotal)));
  if (payload.discount) b.line(twoCol('Discount', `- ${rupees(payload.discount)}`));
  if (payload.serviceCharge != null) b.line(twoCol('Service charge', rupees(payload.serviceCharge)));
  if (payload.tax != null) b.line(twoCol('Tax', rupees(payload.tax)));
  b.bold(true).line(twoCol('TOTAL', rupees(payload.total))).bold(false);
}

function paymentOptions(b, options) {
  if (!options || options.length === 0) return;
  b.rule().line('Pay to:');
  for (const opt of options) {
    b.line(`  ${opt.bank}${opt.accountName ? ` — ${opt.accountName}` : ''}`);
    if (opt.accountNumber) b.line(`  ${opt.accountNumber}`);
  }
}

function footer(b) {
  b.feed(3).cut();
}

/** A bill (pre-payment): what the customer owes, and how to pay it. */
export function renderBill(payload, densityLevel = 0) {
  const b = new Builder(densityLevel);
  header(b, payload.restaurant);
  infoRows(b, payload);
  items(b, payload.items);
  totals(b, payload);
  paymentOptions(b, payload.paymentOptions);
  footer(b);
  return b.build();
}

/** A receipt (post-payment): the record copy, with the invoice number,
 * how it was paid, and the cash drawer kicked. */
export function renderReceipt(payload, densityLevel = 0) {
  const b = new Builder(densityLevel);
  header(b, payload.restaurant);
  b.align('center').bold(true).line('RECEIPT').bold(false).align('left');
  infoRows(b, payload);
  items(b, payload.items);
  totals(b, payload);
  b.rule();
  if (payload.paymentMethod) b.line(twoCol('Paid by', payload.paymentMethod));
  if (payload.amountPaid != null) b.line(twoCol('Amount paid', rupees(payload.amountPaid)));
  b.drawer();
  footer(b);
  return b.build();
}

/** The darkness test strip — one block of ordinary text and one
 * emphasised, so a human can judge on paper whether ordinary receipt
 * text is dark enough and whether emphasis is visibly heavier. */
export function renderTest(densityLevel = 0) {
  const b = new Builder(densityLevel);
  b.align('center').line('PRINT TEST').align('left').rule();
  b.line('Ordinary text — this must be easy to read:');
  b.line('The quick brown fox 0123456789 Rs 1,234');
  b.rule();
  b.bold(true).line('Emphasised text — this must be heavier:');
  b.line('The quick brown fox 0123456789 Rs 1,234').bold(false);
  b.rule().line(`Density level: ${densityLevel || 'printer default'}`);
  footer(b);
  return b.build();
}

/** Render whichever kind the payload names. Throws on an unknown kind so
 * the caller answers the browser with a clear failure. */
export function render(payload, densityLevel = 0) {
  switch (payload?.kind) {
    case 'bill':
      return renderBill(payload, densityLevel);
    case 'receipt':
      return renderReceipt(payload, densityLevel);
    case 'test':
      return renderTest(densityLevel);
    default:
      throw new Error(`unknown ticket kind: ${JSON.stringify(payload?.kind)}`);
  }
}
