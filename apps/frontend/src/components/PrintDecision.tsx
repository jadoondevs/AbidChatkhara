import { Modal } from './ui.tsx';

/**
 * What the old POS asked after every print that did not go straight to
 * a thermal printer, and what this one asks now.
 *
 * A browser cannot tell a completed print from a cancelled one: the
 * system dialog fires the same `afterprint` event either way, and it
 * fires it for "saved a PDF" and "pressed Escape" alike. So rather than
 * guess — and rather than strand the cashier on a screen with no way
 * forward — the till asks the one person who actually knows.
 *
 * Three answers, which are the three things that can be true:
 *
 *  - it printed (or the cashier does not need it to have), so carry on;
 *  - it did not, so send it again;
 *  - it did not and the sale should not happen, so cancel it by the
 *    system's own rules — a void before payment, a refund after — never
 *    by quietly dropping a record.
 *
 * `Continue` is always the safe default, because by the time this is
 * shown the bill is finalised or the payment is recorded. Nothing here
 * re-takes money, and nothing here is required to move on.
 */
export function PrintDecision({
  title,
  detail,
  continueLabel,
  cancelLabel,
  preview,
  busy,
  onContinue,
  onRetry,
  onCancelSale,
}: {
  title: string;
  detail: string;
  continueLabel: string;
  /** Omitted when there is nothing safe to cancel — a settled sale can
   * only be reversed by someone allowed to refund it. */
  cancelLabel?: string | undefined;
  /** The ticket that was just sent, as the server rendered it. Shown so
   * the cashier can answer "did it come out right?" by looking rather
   * than by printing again. Absent when the print threw before the
   * server rendered anything. */
  preview?: string | null | undefined;
  busy: boolean;
  onContinue: () => void;
  onRetry: () => void;
  onCancelSale?: (() => void) | undefined;
}): JSX.Element {
  const choices = (
    <div className="col print-decision">
      <p style={{ margin: 0 }}>{detail}</p>

      <button className="primary big" autoFocus disabled={busy} onClick={onContinue}>
        {continueLabel}
      </button>
      <button className="big" disabled={busy} onClick={onRetry}>
        {busy ? 'Printing…' : 'Retry print'}
      </button>
      {cancelLabel && onCancelSale && (
        <button className="danger big" disabled={busy} onClick={onCancelSale}>
          {cancelLabel}
        </button>
      )}
    </div>
  );

  if (!preview) {
    return (
      <Modal title={title} onClose={onContinue}>
        {choices}
      </Modal>
    );
  }

  return (
    <Modal title={title} wide onClose={onContinue}>
      <div className="print-decision-layout">
        <TicketPreview html={preview} label="What was sent" />
        {choices}
      </div>
    </Modal>
  );
}

/**
 * A ticket, shown as the printer's own renderer produced it.
 *
 * An iframe rather than re-marking-up the ticket in React: the HTML is
 * a complete document with its own 80mm page styling, and rebuilding it
 * here would be a third renderer free to disagree with the two that
 * matter. `sandbox=""` denies it scripts, forms and same-origin access,
 * so the preview is inert paper — it cannot print, navigate or reach
 * anything in the app.
 */
export function TicketPreview({ html, label }: { html: string; label: string }): JSX.Element {
  return (
    <figure className="ticket-preview">
      <figcaption>{label}</figcaption>
      <iframe title={label} srcDoc={html} sandbox="" />
    </figure>
  );
}
