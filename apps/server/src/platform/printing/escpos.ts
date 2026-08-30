/**
 * A small, purposeful ESC/POS command builder — just the commands this
 * system actually needs to print a pro-forma bill or a final receipt on
 * a standard 80mm (or 58mm) thermal printer and kick its cash drawer,
 * not a general-purpose ESC/POS library. Pure byte-buffer construction —
 * no socket, no I/O (see platform/printing/client.ts for that).
 */

const ESC = 0x1b;
const GS = 0x1d;

export type Align = 'left' | 'center' | 'right';

/** Accumulates ESC/POS commands and renders them to one Buffer. */
export class ReceiptBuilder {
  private readonly chunks: Buffer[] = [];

  /** Printer reset — always the first command on a fresh ticket. */
  init(): this {
    this.chunks.push(Buffer.from([ESC, 0x40]));
    return this;
  }

  align(align: Align): this {
    const n = align === 'left' ? 0 : align === 'center' ? 1 : 2;
    this.chunks.push(Buffer.from([ESC, 0x61, n]));
    return this;
  }

  bold(on: boolean): this {
    this.chunks.push(Buffer.from([ESC, 0x45, on ? 1 : 0]));
    return this;
  }

  /** Double-height/width text, for a header line. */
  doubleSize(on: boolean): this {
    this.chunks.push(Buffer.from([GS, 0x21, on ? 0x11 : 0x00]));
    return this;
  }

  /** A line of text, UTF-8 encoded, terminated with a line feed. Most
   * thermal printers handle UTF-8 for at least the Latin range this
   * system needs (English item names, PKR amounts); a printer that
   * doesn't is a hardware/firmware concern outside this module's scope. */
  line(text: string = ''): this {
    this.chunks.push(Buffer.from(text, 'utf8'));
    this.chunks.push(Buffer.from([0x0a]));
    return this;
  }

  /** A full-width dashed rule, for separating sections. */
  rule(width: number = 42, char: string = '-'): this {
    return this.line(char.repeat(width));
  }

  /** Blank line(s) of feed before the cut. */
  feed(lines: number = 1): this {
    for (let i = 0; i < lines; i += 1) this.chunks.push(Buffer.from([0x0a]));
    return this;
  }

  /** Partial paper cut. */
  cut(): this {
    this.chunks.push(Buffer.from([GS, 0x56, 0x01]));
    return this;
  }

  /**
   * Kick the cash drawer wired into the printer's drawer-kick port —
   * "cash drawer opens via the receipt printer's kick port" (spec), not
   * a separate device. Standard ESC p 0 25 250 pulse.
   */
  kickDrawer(): this {
    this.chunks.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
