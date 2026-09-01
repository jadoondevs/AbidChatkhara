import { describe, expect, it } from 'vitest';
import { DEFAULT_DENSITY_LEVEL, ReceiptBuilder } from './escpos.js';

describe('ReceiptBuilder', () => {
  it('init resets, selects Font A and code page 437, and sets print density', () => {
    const buf = new ReceiptBuilder().init({ densityLevel: 5 }).build();
    expect(buf).toEqual(
      Buffer.from([
        0x1b, 0x40, // ESC @   — reset
        0x1b, 0x4d, 0x00, // ESC M 0 — Font A (12x24), not Font B's thin 9x17
        0x1b, 0x74, 0x00, // ESC t 0 — code page 437
        0x1d, 0x28, 0x4b, 0x02, 0x00, 0x31, 0x05, // GS ( K, fn 49 — print density
      ]),
    );
  });

  it('does NOT turn emphasis on for the whole ticket', () => {
    // Darkness is the density command's job. Emphasising everything
    // makes a dark receipt with no difference left between a heading, a
    // total and an item — which is what this printed before.
    const buf = new ReceiptBuilder().init().build();
    expect(buf.includes(Buffer.from([0x1b, 0x45, 0x01]))).toBe(false);
  });

  it('leaves the printer on its own density when the level is 0', () => {
    // An installation whose printer is already set up correctly, or one
    // whose printer mis-handles the command, turns it off entirely.
    const buf = new ReceiptBuilder().init({ densityLevel: 0 }).build();
    expect(buf).toEqual(Buffer.from([0x1b, 0x40, 0x1b, 0x4d, 0x00, 0x1b, 0x74, 0x00]));
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x4b]))).toBe(false);
  });

  it('refuses a density level outside the printer scale rather than sending nonsense', () => {
    for (const densityLevel of [-1, 9, 255]) {
      const buf = new ReceiptBuilder().init({ densityLevel }).build();
      expect(buf.includes(Buffer.from([0x1d, 0x28, 0x4b])), `level ${densityLevel}`).toBe(false);
    }
  });

  it('frames the density command so a printer that ignores it skips exactly those bytes', () => {
    const buf = new ReceiptBuilder().init({ densityLevel: 8 }).build();
    const at = buf.indexOf(Buffer.from([0x1d, 0x28, 0x4b]));
    expect(at).toBeGreaterThan(-1);
    // pL/pH say two payload bytes follow (fn and m) — the framing that
    // makes this safe on hardware that does not implement function 49.
    expect(buf[at + 3]).toBe(0x02);
    expect(buf[at + 4]).toBe(0x00);
    expect(buf.length).toBe(at + 7);
  });

  it('defaults to a level that is dark without over-burning', () => {
    expect(DEFAULT_DENSITY_LEVEL).toBeGreaterThan(0);
    expect(DEFAULT_DENSITY_LEVEL).toBeLessThanOrEqual(8);
    expect(new ReceiptBuilder().init().build().subarray(-1)).toEqual(Buffer.from([DEFAULT_DENSITY_LEVEL]));
  });

  it('bold turns emphasis on and OFF, so normal text is normal', () => {
    const buf = new ReceiptBuilder().bold(true).line('TOTAL').bold(false).line('Subtotal').build();
    expect(buf.indexOf(Buffer.from([0x1b, 0x45, 0x01]))).toBeGreaterThan(-1);
    expect(buf.indexOf(Buffer.from([0x1b, 0x45, 0x00]))).toBeGreaterThan(-1);
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

  it('emphasis changes only where a line asks for it', () => {
    // The state a printer is in when it reaches each line, in order —
    // this is what "hierarchy" means at the byte level.
    const buf = new ReceiptBuilder().init().line('normal').bold(true).line('HEADING').bold(false).line('normal again').build();
    const text = buf.toString('latin1');
    const emphasisOn = text.indexOf('\u001b\u0045\u0001');
    const emphasisOff = text.indexOf('\u001b\u0045\u0000');

    expect(text.indexOf('normal')).toBeLessThan(emphasisOn);
    expect(emphasisOn).toBeLessThan(text.indexOf('HEADING'));
    expect(text.indexOf('HEADING')).toBeLessThan(emphasisOff);
    expect(emphasisOff).toBeLessThan(text.indexOf('normal again'));
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
