import { useEffect, useState } from 'react';
import { useCreatePartner, useItemOwnership, useMenu, usePartners, useSetItemOwnership } from '../api/hooks.js';
import { ErrorBanner, Loading } from '../components/ui.tsx';

/**
 * Screen 8: partners, and per item the ownership split with a live check
 * that shares total 100%. Saving warns first that the change applies
 * from now forward only — past sales keep the shares they were
 * allocated under (docs/decisions/006), and a manager who doesn't know
 * that will assume otherwise.
 */
export function PartnerConfigScreen(): JSX.Element {
  const partners = usePartners(true);
  const createPartner = useCreatePartner();
  const menu = useMenu();
  const [partnerName, setPartnerName] = useState('');
  const [itemId, setItemId] = useState<number | ''>('');

  return (
    <div className="col" style={{ maxWidth: 1000 }}>
      <h1 style={{ margin: 0 }}>Partners</h1>
      <ErrorBanner error={createPartner.error} />

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div className="card col">
          <h3 style={{ margin: 0 }}>Partners</h3>
          {partners.isLoading && <Loading />}
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {partners.data?.map((partner) => (
              <li key={partner.id}>
                {partner.name} {!partner.active && <span className="muted">(inactive)</span>}
              </li>
            ))}
          </ul>
          <input placeholder="New partner name" value={partnerName} onChange={(event) => setPartnerName(event.target.value)} />
          <button
            className="primary"
            disabled={!partnerName.trim() || createPartner.isPending}
            onClick={() => createPartner.mutate({ name: partnerName.trim() }, { onSuccess: () => setPartnerName('') })}
          >
            Add partner
          </button>
        </div>

        <div className="card col">
          <h3 style={{ margin: 0 }}>Item ownership</h3>
          <select value={itemId} onChange={(event) => setItemId(event.target.value === '' ? '' : Number(event.target.value))}>
            <option value="">Pick an item…</option>
            {menu.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {itemId !== '' && <OwnershipEditor itemId={itemId} />}
        </div>
      </div>
    </div>
  );
}

function OwnershipEditor({ itemId }: { itemId: number }): JSX.Element {
  const partners = usePartners();
  const ownership = useItemOwnership(itemId);
  const setOwnership = useSetItemOwnership();
  const [shares, setShares] = useState<Record<number, number>>({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const next: Record<number, number> = {};
    for (const share of ownership.data ?? []) next[share.partnerId] = share.shareBp;
    setShares(next);
  }, [ownership.data]);

  const entries = Object.entries(shares)
    .map(([partnerId, shareBp]) => ({ partnerId: Number(partnerId), shareBp }))
    .filter((entry) => entry.shareBp > 0);
  const totalBp = entries.reduce((total, entry) => total + entry.shareBp, 0);
  const balanced = totalBp === 10_000;

  if (ownership.isLoading) return <Loading />;

  return (
    <div className="col">
      <ErrorBanner error={setOwnership.error} />
      {partners.data?.map((partner) => (
        <div key={partner.id} className="row">
          <span style={{ flex: 1 }}>{partner.name}</span>
          <input
            style={{ maxWidth: 120 }}
            inputMode="decimal"
            placeholder="0"
            value={shares[partner.id] === undefined ? '' : String(shares[partner.id]! / 100)}
            onChange={(event) => {
              const percent = Number(event.target.value);
              setShares((current) => ({ ...current, [partner.id]: Number.isFinite(percent) ? Math.round(percent * 100) : 0 }));
            }}
          />
          <span className="muted">%</span>
        </div>
      ))}

      <div className="row">
        <strong style={{ flex: 1, color: balanced ? 'var(--success)' : 'var(--warn)' }}>
          Total {totalBp / 100}% {balanced ? '✓' : '— must be exactly 100%'}
        </strong>
      </div>

      {confirming ? (
        <div className="card">
          <p>
            This applies <strong>from now forward only</strong>. Past sales keep the shares they were allocated under and will not change.
          </p>
          <div className="row">
            <button className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={setOwnership.isPending}
              onClick={() => setOwnership.mutate({ itemId, split: entries }, { onSuccess: () => setConfirming(false) })}
            >
              Save split
            </button>
          </div>
        </div>
      ) : (
        <button className="primary" disabled={!balanced} onClick={() => setConfirming(true)}>
          Save split
        </button>
      )}
    </div>
  );
}
