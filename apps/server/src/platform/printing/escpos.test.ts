import { describe, expect, it } from 'vitest';
import { ReceiptBuilder } from './escpos.js';

describe('ReceiptBuilder', () => {
  it('init resets, then selects Font A, code page 437, and emphasis', () => {
    // Emphasis is not decoration: without it a thermal head prints
    // grey, which is the "the printer must be broken" complaint.
    const buf = new ReceiptBuilder().init().build();
    expect(buf).toEqual(Buffer.from([0x1b, 0x40, 0x1b, 0x4d, 0x00, 0x1b, 0x74, 0x00, 0x1b, 0x45, 0x01]));
  });

  it('bold(false) returns to the ticket base rather than going light', () => {
    const buf = new ReceiptBuilder().init().bold(true).bold(false).build();
    // The last two emphasis commands are both "on": nothing on a
    // receipt should print lighter than the receipt itself.
    expect(buf.subarray(-6)).toEqual(Buffer.from([0x1b, 0x45, 0x01, 0x1b, 0x45, 0x01]));
  });

  it('bold(false) on a builder with no init is plain off', () => {
    expect(new ReceiptBuilder().bold(false).build()).toEqual(Buffer.from([0x1b, 0x45, 0]));
  });

  it('transliterates typographic characters a code page cannot render', () => {
    const buf = new ReceiptBuilder().line('Voided \u2014 "spilled" \u2026 2 \u00d7 Karahi').build();
    expect(buf.toString('utf8')).toBe('Voided - "spilled" ... 2 x Karahi\n');
  });

  it('passes other non-ASCII through rather than replacing it', () => {
    // A restaurant's own item name is not this module's to censor.
    const buf = new ReceiptBuilder().line('Kar\u0101hi').build();
    expect(buf.toString('utf8')).toBe('Kar\u0101hi\n');
  });

  it('align emits ESC a n for left/center/right', () => {
    expect(new ReceiptBuilder().align('left').build()).toEqual(Buffer.from([0x1b, 0x61, 0]));
    expect(new ReceiptBuilder().align('center').build()).toEqual(Buffer.from([0x1b, 0x61, 1]));
    expect(new ReceiptBuilder().align('right').build()).toEqual(Buffer.from([0x1b, 0x61, 2]));
  });

  it('bold toggles ESC E 1/0', () => {
    expect(new ReceiptBuilder().bold(true).build()).toEqual(Buffer.from([0x1b, 0x45, 1]));
    expect(new ReceiptBuilder().bold(false).build()).toEqual(Buffer.from([0x1b, 0x45, 0]));
  });

  it('line writes UTF-8 text terminated with a line feed', () => {
    const buf = new ReceiptBuilder().line('Rs 1,234.56').build();
    expect(buf).toEqual(Buffer.concat([Buffer.from('Rs 1,234.56', 'utf8'), Buffer.from([0x0a])]));
  });

  it('an empty line is just a line feed', () => {
    expect(new ReceiptBuilder().line().build()).toEqual(Buffer.from([0x0a]));
  });

  it('rule repeats the given character to the given width', () => {
    const buf = new ReceiptBuilder().rule(5, '=').build();
    expect(buf.toString('utf8')).toBe('=====\n');
  });

  it('cut emits GS V 1', () => {
    expect(new ReceiptBuilder().cut().build()).toEqual(Buffer.from([0x1d, 0x56, 0x01]));
  });

  it('kickDrawer emits the standard ESC p 0 25 250 pulse', () => {
    expect(new ReceiptBuilder().kickDrawer().build()).toEqual(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]));
  });

  it('chains commands in call order, concatenated', () => {
    const buf = new ReceiptBuilder().align('center').bold(true).line('Restaurant').bold(false).cut().build();
    const expected = Buffer.concat([
      Buffer.from([0x1b, 0x61, 1]),
      Buffer.from([0x1b, 0x45, 1]),
      Buffer.from('Restaurant', 'utf8'),
      Buffer.from([0x0a]),
      Buffer.from([0x1b, 0x45, 0]),
      Buffer.from([0x1d, 0x56, 0x01]),
    ]);
    expect(buf).toEqual(expected);
  });
});
