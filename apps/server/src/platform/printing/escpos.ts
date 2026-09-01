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

/**
 * Typographic characters this system's own strings contain, mapped to
 * what a thermal printer's single-byte code page can actually render.
 *
 * A receipt printer is not a browser: it decodes one byte at a time
 * against a code page, so an em dash sent as UTF-8 arrives as two or
 * three random glyphs. These are all characters the POS itself
 * produces — in settings text, in "Voided — reason", in the masked
 * account number — so they are worth translating rather than leaving
 * to be printed as noise.
 */
const TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‐-―]/g, '-'], // hyphens and dashes
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/…/g, '...'],
  [/[×✕]/g, 'x'],
  [/[•●]/g, '*'],
  [/₨|₹/g, 'Rs'],
  [/\u00a0/g, ' '], // a non-breaking space is not a space to a printer
];

/**
 * Text as bytes the printer will render.
 *
 * Anything still non-ASCII after transliteration is passed through as
 * UTF-8 rather than dropped: a printer configured for a multi-byte code
 * page can render it, and silently replacing a restaurant's own item
 * name with question marks would be worse than a glyph that might not
 * land.
 */
export function encodeTicketText(text: string): Buffer {
  let out = text;
  for (const [pattern, replacement] of TRANSLITERATIONS) out = out.replace(pattern, replacement);
  return Buffer.from(out, 'utf8');
}

/** Accumulates ESC/POS commands and renders them to one Buffer. */
export class ReceiptBuilder {
  private readonly chunks: Buffer[] = [];

  /**
   * Whether ordinary text on this ticket is emphasised. Set by `init`,
   * because emphasis is what makes a thermal receipt readable — see the
   * note there.
   */
  private baseEmphasis = false;

  /**
   * Printer reset, then the three settings that decide whether the
   * ticket is readable at all.
   *
   * `ESC @` alone leaves the printer on ITS defaults, which on cheap
   * hardware means the small Font B and no emphasis — the thin, grey
   * output that sends people looking for a hardware fault. So:
   *
   *  - `ESC M 0` selects Font A (12x24 rather than Font B's 9x17):
   *    bigger, and every glyph is drawn with more dots.
   *  - `ESC E 1` turns emphasis on for the whole ticket. On a thermal
   *    printer emphasis means each dot is struck harder, which is the
   *    standard way to get black rather than grey. `bold()` still
   *    exists for headings, and `bold(false)` returns to this base
   *    rather than clearing it — nothing on a receipt should be
   *    lighter than the receipt.
   *  - `ESC t 0` selects code page 437, so the single-byte characters
   *    `encodeTicketText` produces decode to the glyphs intended.
   */
  init(): this {
    this.chunks.push(Buffer.from([ESC, 0x40]));
    this.chunks.push(Buffer.from([ESC, 0x4d, 0x00]));
    this.chunks.push(Buffer.from([ESC, 0x74, 0x00]));
    this.baseEmphasis = true;
    this.chunks.push(Buffer.from([ESC, 0x45, 1]));
    return this;
  }

  align(align: Align): this {
    const n = align === 'left' ? 0 : align === 'center' ? 1 : 2;
    this.chunks.push(Buffer.from([ESC, 0x61, n]));
    return this;
  }

  /**
   * Extra weight for a heading. Turning it off returns to the ticket's
   * base emphasis, so an ordinary line after a bold one is still dark.
   */
  bold(on: boolean): this {
    const emphasised = on || this.baseEmphasis;
    this.chunks.push(Buffer.from([ESC, 0x45, emphasised ? 1 : 0]));
    return this;
  }

  /** Double-height/width text, for a header line. */
  doubleSize(on: boolean): this {
    this.chunks.push(Buffer.from([GS, 0x21, on ? 0x11 : 0x00]));
    return this;
  }

  /** A line of text terminated with a line feed. See
   * `encodeTicketText` for how it reaches the printer. */
  line(text: string = ''): this {
    this.chunks.push(encodeTicketText(text));
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
