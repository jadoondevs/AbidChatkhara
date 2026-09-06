import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useReopenOrder, useVoidOrder } from '../api/hooks.js';
import { ErrorBanner, ManagerApproval, Modal } from './ui.tsx';

const forbidden = (error: unknown): boolean => error instanceof ApiError && error.isForbidden;

/**
 * Reopen a billed order so its lines can be edited again.
 *
 * Billing freezes an order — the server refuses to touch a line while it
 * is `billed` ("reopen it first"). This is the button that error asks
 * for. Reopening keeps `first_billed_at`, so taking a line off afterwards
 * is still a void with a reason, never a silent edit. Manager-only on the
 * server; if the till is signed in as someone else, a 403 asks a manager
 * to approve this one call.
 */
export function ReopenOrderButton({ orderId }: { orderId: number }): JSX.Element {
  const reopen = useReopenOrder();
  const [needsApproval, setNeedsApproval] = useState(false);

  const submit = (token?: string) => {
    reopen.mutate(
      { orderId, ...(token === undefined ? {} : { token }) },
      {
        onSuccess: () => setNeedsApproval(false),
        onError: (error) => {
          if (forbidden(error)) setNeedsApproval(true);
        },
      },
    );
  };

  return (
    <>
      <ErrorBanner error={forbidden(reopen.error) ? null : reopen.error} />
      <button className="ghost" disabled={reopen.isPending} onClick={() => submit()}>
        {reopen.isPending ? 'Reopening…' : 'Reopen order'}
      </button>
      {needsApproval && (
        <ManagerApproval action="reopen order" onApproved={(token) => submit(token)} onCancel={() => setNeedsApproval(false)} />
      )}
    </>
  );
}

/**
 * Void a whole order, with a reason.
 *
 * The honest way to get rid of an order that should not have existed —
 * a mistaken bill, a walk-out, a duplicate. Nothing is deleted: the
 * order stays on the record marked voided (with the reason and who
 * authorised it) and leaves the floor, so it stops holding a shift open
 * and stops sitting in "Awaiting payment". The server refuses this once
 * anything has been paid — that is a refund, a different decision — and
 * requires a manager, so a 403 asks one to approve this one call.
 */
export function VoidOrderButton({
  orderId,
  onVoided,
  label = 'Void order',
}: {
  orderId: number;
  onVoided: () => void;
  label?: string;
}): JSX.Element {
  const voidOrder = useVoidOrder();
  const [reason, setReason] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState<string | null>(null);

  const submit = (text: string, token?: string) => {
    voidOrder.mutate(
      { orderId, reason: text, ...(token === undefined ? {} : { token }) },
      {
        onSuccess: () => {
          setReason(null);
          setNeedsApproval(null);
          onVoided();
        },
        onError: (error) => {
          if (forbidden(error)) {
            setReason(null);
            setNeedsApproval(text);
          }
        },
      },
    );
  };

  return (
    <>
      <button className="danger" disabled={voidOrder.isPending} onClick={() => setReason('')}>
        {label}
      </button>

      {reason !== null && (
        <Modal title="Void this order?" onClose={() => setReason(null)}>
          <div className="col">
            <p className="muted" style={{ margin: 0 }}>
              The order is cancelled and leaves the floor, but stays on the record as voided — nothing is deleted. Only do this
              when nothing has been paid; a paid bill is refunded instead.
            </p>
            <ErrorBanner error={forbidden(voidOrder.error) ? null : voidOrder.error} />
            <div>
              <label htmlFor="void-order-reason">Reason</label>
              <input
                id="void-order-reason"
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && reason.trim()) submit(reason.trim());
                }}
              />
            </div>
            <button className="danger big" disabled={voidOrder.isPending || !reason.trim()} onClick={() => submit(reason.trim())}>
              {voidOrder.isPending ? 'Voiding…' : 'Void order'}
            </button>
          </div>
        </Modal>
      )}

      {needsApproval !== null && (
        <ManagerApproval action="void order" onApproved={(token) => submit(needsApproval, token)} onCancel={() => setNeedsApproval(null)} />
      )}
    </>
  );
}
