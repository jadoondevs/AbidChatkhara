import { describe, expect, it } from 'vitest';
import { ReceiptBuilder } from './escpos.js';

describe('ReceiptBuilder', () => {
  it('init emits ESC @', () => {
    const buf = new ReceiptBuilder().init().build();
    expect(buf).toEqual(Buffer.from([0x1b, 0x40]));
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
    const buf = new ReceiptBuilder().init().align('center').bold(true).line('Restaurant').bold(false).cut().build();
    const expected = Buffer.concat([
      Buffer.from([0x1b, 0x40]),
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
