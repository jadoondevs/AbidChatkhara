import type { PrintOutcome } from './types.js';

/**
 * Put a ticket the server rendered through the browser's own print
 * dialog — the fallback for a till with no POS thermal printer.
 *
 * This is what reaches Windows: the print dialog it opens is the system
 * one, so "Microsoft Print to PDF" and every installed printer are
 * available, and the cashier can save the receipt as a PDF exactly as
 * the old POS did.
 *
 * The HTML is written into a hidden same-origin iframe rather than a
 * popup window: a popup would be blocked by default (this is not a
 * click the browser attributes to the user by the time the server has
 * answered), and printing the main document would print the POS around
 * the receipt.
 *
 * Resolves once the dialog has been dismissed — printed OR cancelled,
 * which the browser does not distinguish. That is deliberate: a
 * cancelled print is not a failed sale, and nothing downstream may
 * treat it as one.
 */
export async function printHtmlViaBrowser(html: string): Promise<void> {
  const iframe = document.createElement('iframe');
  // Off-screen rather than `display: none`: a hidden iframe has no
  // layout in some engines, and a frame with no layout prints blank.
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.border = '0';
  iframe.style.opacity = '0';

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      // Leave the frame up briefly: removing it while the print job is
      // still being spooled cancels the job in some browsers.
      window.setTimeout(() => iframe.remove(), 1000);
      resolve();
    };

    iframe.onload = () => {
      const frameWindow = iframe.contentWindow;
      if (!frameWindow) {
        finish();
        return;
      }
      // `afterprint` fires for both "printed" and "cancelled" — the
      // browser deliberately does not say which, and neither case is a
      // failure here.
      frameWindow.addEventListener('afterprint', finish);
      try {
        frameWindow.focus();
        frameWindow.print();
      } catch {
        // A browser that refuses to print at all must not leave the
        // caller hanging — the sale is already complete either way.
        finish();
        return;
      }
      // Safety net for engines that never fire `afterprint`.
      window.setTimeout(finish, 60_000);
    };

    document.body.appendChild(iframe);
    iframe.srcdoc = html;
  });
}

/**
 * Carry out whatever the server said happened to a print: nothing more
 * to do when the thermal printer took it, or open the system dialog
 * when it handed back HTML.
 *
 * Returns how the ticket was actually printed, so a screen can tell the
 * cashier "printed" versus "sent to Windows printing" rather than
 * leaving them wondering where the receipt went.
 */
export async function completePrint(outcome: PrintOutcome): Promise<'thermal' | 'fallback'> {
  if (outcome.method === 'thermal') return 'thermal';
  await printHtmlViaBrowser(outcome.html);
  return 'fallback';
}
