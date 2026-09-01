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
 * How dark this printer should burn.
 *
 * Thermal darkness is a property of the PRINTER — how long each dot is
 * heated — not of the text. It is the only lever that makes ordinary
 * text dark without making it bold, which is why it exists here: the
 * alternative (emphasising every line) produces a dark receipt with no
 * difference left between a heading and a total and an item.
 *
 * `0` means "leave the printer on whatever it is configured for" and
 * sends nothing. `1`–`8` are passed through as the `m` byte of the
 * ESC/POS print-density function; the printer maps them onto its own
 * scale, so the right value is the one that looks right on the paper —
 * which is why it is a setting and why Settings has a test print.
 */
export interface TicketFormat {
  readonly densityLevel: number;
}

/** Dark enough to read on cheap paper, on a printer that honours it.
 * Deliberately not the maximum: over-burning bleeds thin strokes
 * together and shortens the head's life. */
export const DEFAULT_DENSITY_LEVEL = 5;

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
   * Printer reset, then the settings that decide whether the ticket is
   * readable at all.
   *
   * `ESC @` alone leaves the printer on ITS defaults, which on cheap
   * hardware — or on a printer whose density was turned down — means
   * thin grey text that sends people looking for a hardware fault. So:
   *
   *  - `ESC M 0` selects Font A (12x24 rather than Font B's 9x17):
   *    bigger, and every glyph is drawn with more dots.
   *  - `ESC t 0` selects code page 437, so the single-byte characters
   *    `encodeTicketText` produces decode to the glyphs intended.
   *  - `GS ( K` sets print density, when a level is configured. This is
   *    the command that makes ORDINARY text dark. Emphasis is not used
   *    for that job: emphasising every line would make the receipt
   *    uniformly heavy and leave no difference between a total and the
   *    line above it.
   *
   * The density command is safe to send to a printer that does not
   * implement it. `GS (` is the length-prefixed command family — pL/pH
   * tell the printer how many bytes follow — so a printer that does not
   * know function 49 skips exactly those bytes instead of printing them
   * as text. That is why it is this command and not one of the
   * vendor-specific heating commands (`ESC 7 n1 n2 n3`, `DC2 # n`),
   * which have no framing and litter the paper on hardware that ignores
   * them.
   */
  init(format: TicketFormat = { densityLevel: DEFAULT_DENSITY_LEVEL }): this {
    this.chunks.push(Buffer.from([ESC, 0x40]));
    this.chunks.push(Buffer.from([ESC, 0x4d, 0x00]));
    this.chunks.push(Buffer.from([ESC, 0x74, 0x00]));

    const level = Math.trunc(format.densityLevel);
    if (level > 0 && level <= 8) {
      // GS ( K pL pH fn m — pL/pH = 2 bytes of payload (fn, m); fn = 49
      // is the print-density function.
      this.chunks.push(Buffer.from([GS, 0x28, 0x4b, 0x02, 0x00, 0x31, level]));
    }
    return this;
  }

  align(align: Align): this {
    const n = align === 'left' ? 0 : align === 'center' ? 1 : 2;
    this.chunks.push(Buffer.from([ESC, 0x61, n]));
    return this;
  }

  /**
   * Emphasis, and nothing else uses it.
   *
   * It is the ticket's only weight difference — a heading and a TOTAL
   * are emphasised, everything else is not — so it has to actually turn
   * off again. Making ordinary text dark is the density command's job
   * (see `init`); if that job is given to emphasis instead, the receipt
   * prints as one uniform weight and stops being readable in the way
   * that matters, which is telling the total apart from the line above
   * it at a glance.
   */
  bold(on: boolean): this {
    this.chunks.push(Buffer.from([ESC, 0x45, on ? 1 : 0]));
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
