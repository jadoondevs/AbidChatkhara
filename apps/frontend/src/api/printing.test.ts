import { afterEach, describe, expect, it, vi } from 'vitest';
import { completePrint } from './printing.js';
import type { PrintOutcome } from './types.js';

/**
 * The one thing these tests lock down: opening the Windows/browser print
 * dialog is a SUCCESS, not a failure. `completePrint` resolves for the
 * fallback path exactly as it does for the thermal path, so the mutation
 * that calls it runs its onSuccess and the till never shows a "the print
 * failed" dialog just because Windows printing was used.
 *
 * These tests deliberately do NOT — and cannot — assert anything about
 * whether paper physically came out of the printer. The browser does not
 * report that, and neither `afterprint` nor this code can tell a printed
 * job from a cancelled one. What is tested is only the control flow:
 * fallback resolves rather than throwing.
 */

// A minimal stand-in for the slice of the DOM printHtmlViaBrowser touches.
// Setting `srcdoc` "loads" the frame (onload), and print() then fires the
// `afterprint` the real dialog fires when it is dismissed — printed or
// cancelled, the browser does not say which, and neither does this fake.
function installFakeDom(): void {
  const listeners = new Map<string, () => void>();
  const frameWindow = {
    addEventListener: (type: string, handler: () => void) => listeners.set(type, handler),
    focus: () => {},
    print: () => listeners.get('afterprint')?.(),
  };

  const iframe: Record<string, unknown> = {
    setAttribute: () => {},
    style: {},
    contentWindow: frameWindow,
    remove: () => {},
    set srcdoc(_html: string) {
      // The real frame loads asynchronously; mirror that so the promise
      // is driven by the load handler, not by assignment order.
      queueMicrotask(() => (iframe.onload as (() => void) | undefined)?.());
    },
  };

  vi.stubGlobal('document', {
    createElement: () => iframe,
    body: { appendChild: () => {} },
  });
  vi.stubGlobal('window', { setTimeout: () => 0 });
}

describe('api/printing completePrint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the thermal path without touching the DOM', async () => {
    const outcome: PrintOutcome = { method: 'thermal' };
    await expect(completePrint(outcome)).resolves.toEqual({ via: 'thermal', html: null });
  });

  it('treats the Windows/browser dialog as a success, keeping the rendered ticket', async () => {
    installFakeDom();
    const html = '<html><body>RECEIPT</body></html>';
    const outcome: PrintOutcome = { method: 'fallback', reason: 'not_configured', detail: null, html };

    // Resolves — the whole point. A rejection here is what used to light
    // up the false "No POS printer / the print failed" dialog.
    await expect(completePrint(outcome)).resolves.toEqual({ via: 'fallback', html });
  });
});
