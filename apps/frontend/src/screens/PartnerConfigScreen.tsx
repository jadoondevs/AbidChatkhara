import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCategories,
  useCreatePartner,
  useItemOwnership,
  useMenu,
  usePartnerRecord,
  usePartners,
  useSetItemOwnership,
  useSetOwnershipForCategories,
  useUpdatePartner,
} from '../api/hooks.js';
import type { OwnershipShare, Partner, PartnerRecord } from '../api/types.js';
import { ErrorBanner, Loading, Money } from '../components/ui.tsx';

/**
 * Screen 8: the partners themselves, and per item the ownership split
 * with a live check that shares total 100%.
 *
 * A partner is a person the restaurant owes money to, so this screen
 * has to answer more than "who exists": what do they own today, what
 * have they actually been credited, and what happens when one of them
 * leaves. Saving a split warns first that the change applies from now
 * forward only — past sales keep the shares they were allocated under
 * (docs/decisions/006), and a manager who doesn't know that will assume
 * otherwise.
 */
export function PartnerConfigScreen(): JSX.Element {
  const partners = usePartners(true);
  const createPartner = useCreatePartner();
  const menu = useMenu();
  const [partnerName, setPartnerName] = useState('');
  const [itemId, setItemId] = useState<number | ''>('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  return (
    <div className="col" style={{ maxWidth: 1100 }}>
      <div>
        <p className="page-kicker">Ownership</p>
        <h1 style={{ margin: 0 }}>Partners</h1>
      </div>
      {/* Three screens name people, and a manager should never have to
          work out which is which by trying them. */}
      <p className="muted" style={{ marginTop: 0 }}>
        The people who own items on the menu and are credited a share of what those items sell for. Separate from{' '}
        <Link to="/config/people">People</Link>, who are whose meals the restaurant tracks, and from{' '}
        <Link to="/settings">Settings → Users</Link>, who are the accounts that sign in to this till.
      </p>
      <ErrorBanner error={createPartner.error} />

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        <div className="card col">
          <h3 style={{ margin: 0 }}>Partners</h3>
          {partners.isLoading && <Loading />}
          {partners.data?.length === 0 && <p className="muted">No partners yet.</p>}

          <div className="col partner-list">
            {partners.data?.map((partner) => (
              <PartnerRow
                key={partner.id}
                partner={partner}
                selected={partner.id === selectedId}
                onSelect={() => setSelectedId(partner.id === selectedId ? null : partner.id)}
              />
            ))}
          </div>

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

      <BulkOwnershipCard />

      {selectedId !== null && <PartnerRecordPanel partnerId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

/**
 * The percent-per-partner grid, shared by both ownership editors.
 *
 * Held in basis points because that is what the server stores and what
 * "must total exactly 100%" is checked in; the field shows percent
 * because that is what a partner agreement is written in.
 */
function SplitInputs({
  partners,
  shares,
  onChange,
}: {
  partners: readonly Partner[];
  shares: Record<number, number>;
  onChange: (partnerId: number, shareBp: number) => void;
}): JSX.Element {
  return (
    <div className="col">
      {partners.map((partner) => (
        <div key={partner.id} className="row">
          <span style={{ flex: 1 }}>{partner.name}</span>
          <input
            style={{ maxWidth: 120 }}
            inputMode="decimal"
            placeholder="0"
            aria-label={`${partner.name} share`}
            value={shares[partner.id] === undefined ? '' : String(shares[partner.id]! / 100)}
            onChange={(event) => {
              const percent = Number(event.target.value);
              onChange(partner.id, Number.isFinite(percent) ? Math.round(percent * 100) : 0);
            }}
          />
          <span className="muted">%</span>
        </div>
      ))}
    </div>
  );
}

/** The entries actually worth sending: a partner left blank owns
 * nothing and should not get a zero-share row. */
function splitEntries(shares: Record<number, number>): OwnershipShare[] {
  return Object.entries(shares)
    .map(([partnerId, shareBp]) => ({ partnerId: Number(partnerId), shareBp }))
    .filter((entry) => entry.shareBp > 0);
}

function SplitTotal({ totalBp }: { totalBp: number }): JSX.Element {
  const balanced = totalBp === 10_000;
  return (
    <strong style={{ flex: 1, color: balanced ? 'var(--success)' : 'var(--warn)' }}>
      Total {totalBp / 100}% {balanced ? '✓' : '— must be exactly 100%'}
    </strong>
  );
}

/**
 * One split applied to whole categories at once.
 *
 * A fifty-item menu is usually owned by a handful of arrangements, not
 * fifty — a couple of partners split the grill between them and one owns
 * everything else — and setting that item by item is where menu
 * configuration quietly stops being finished. This does it in one
 * operation per arrangement, and every item it touches stays
 * individually editable above afterwards, because the bulk apply writes
 * exactly the same rows the per-item editor writes.
 */
function BulkOwnershipCard(): JSX.Element {
  const partners = usePartners();
  const categories = useCategories();
  const menu = useMenu();
  const apply = useSetOwnershipForCategories();
  const [picked, setPicked] = useState<number[]>([]);
  const [shares, setShares] = useState<Record<number, number>>({});
  const [confirming, setConfirming] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  const entries = splitEntries(shares);
  const totalBp = entries.reduce((total, entry) => total + entry.shareBp, 0);
  const balanced = totalBp === 10_000;
  // Counted from the same menu the manager is looking at, so the
  // confirmation names a real number rather than "some items".
  const itemCount = (menu.data ?? []).filter((item) => picked.includes(item.categoryId)).length;

  const toggle = (categoryId: number) => {
    setApplied(null);
    setPicked((current) => (current.includes(categoryId) ? current.filter((id) => id !== categoryId) : [...current, categoryId]));
  };

  return (
    <div className="card col">
      <h3 style={{ margin: 0 }}>Ownership by category</h3>
      <p className="muted" style={{ margin: 0 }}>
        Give every item in the chosen categories the same split. Each item can still be changed on its own above.
      </p>
      <ErrorBanner error={apply.error} />

      <div className="category-picker">
        {categories.data?.map((category) => (
          <label key={category.id} className={`category-pick${picked.includes(category.id) ? ' picked' : ''}`}>
            <input type="checkbox" checked={picked.includes(category.id)} onChange={() => toggle(category.id)} />
            <span>{category.name}</span>
          </label>
        ))}
      </div>

      <SplitInputs
        partners={partners.data ?? []}
        shares={shares}
        onChange={(partnerId, shareBp) => {
          setApplied(null);
          setShares((current) => ({ ...current, [partnerId]: shareBp }));
        }}
      />
      <div className="row">
        <SplitTotal totalBp={totalBp} />
      </div>

      {applied !== null && (
        <p className="muted" style={{ margin: 0 }}>
          Applied to {applied} item{applied === 1 ? '' : 's'}.
        </p>
      )}

      {confirming ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            This replaces the split on <strong>{itemCount}</strong> item{itemCount === 1 ? '' : 's'}, including any you have already set by hand.
            It applies <strong>from now forward only</strong>: past sales keep the shares they were allocated under.
          </p>
          <div className="row">
            <button className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={apply.isPending}
              onClick={() =>
                apply.mutate(
                  { categoryIds: picked, split: entries },
                  {
                    onSuccess: (result) => {
                      setApplied(result.itemIds.length);
                      setConfirming(false);
                    },
                  },
                )
              }
            >
              Apply to {itemCount} item{itemCount === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      ) : (
        <button className="primary" disabled={!balanced || picked.length === 0} onClick={() => setConfirming(true)}>
          Apply to selected categories
        </button>
      )}
    </div>
  );
}

/**
 * One partner, with the two things a manager does to one: correct the
 * spelling of their name, and record that they have left (or come
 * back). Both are audited server-side as separate operations.
 */
function PartnerRow({ partner, selected, onSelect }: { partner: Partner; selected: boolean; onSelect: () => void }): JSX.Element {
  const update = useUpdatePartner();
  const record = usePartnerRecord(selected ? partner.id : null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(partner.name);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // How many items would keep crediting this partner after they go.
  // Deactivating is a record that someone left, not a reassignment of
  // what they own — saying so is the difference between a clean
  // handover and a month of misallocated sales.
  const stillOwns = record.data?.ownedItems.length ?? null;

  return (
    <div className={`partner-row${selected ? ' selected' : ''}`}>
      <div className="row">
        {renaming ? (
          <input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} style={{ flex: 1 }} />
        ) : (
          <button className="link-button" style={{ flex: 1, textAlign: 'left' }} onClick={onSelect}>
            {partner.name}
          </button>
        )}
        {!partner.active && <span className="pill">Left</span>}
      </div>

      <ErrorBanner error={update.error} />

      {renaming ? (
        <div className="row">
          <button
            className="primary"
            disabled={!draftName.trim() || update.isPending}
            onClick={() =>
              update.mutate({ id: partner.id, name: draftName.trim() }, { onSuccess: () => setRenaming(false) })
            }
          >
            Save name
          </button>
          <button
            className="ghost"
            onClick={() => {
              setDraftName(partner.name);
              setRenaming(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : confirmingLeave ? (
        <div className="col" style={{ gap: 6 }}>
          <p className="muted" style={{ margin: 0 }}>
            {stillOwns === null
              ? 'Checking what they own…'
              : stillOwns === 0
                ? 'They own no items — nothing will be credited to them from now on.'
                : `They still own ${stillOwns} item${stillOwns === 1 ? '' : 's'}. Marking them as left does NOT reassign those — every future sale of them is still credited to this partner. Change the splits first if that isn't what you want.`}
          </p>
          <div className="row">
            <button
              className="danger"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: partner.id, active: false }, { onSuccess: () => setConfirmingLeave(false) })}
            >
              Mark as left
            </button>
            <button className="ghost" onClick={() => setConfirmingLeave(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row partner-row-actions">
          <button className="ghost" onClick={onSelect}>
            {selected ? 'Hide record' : 'View record'}
          </button>
          <button
            className="ghost"
            onClick={() => {
              setDraftName(partner.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          {partner.active ? (
            <button
              className="ghost"
              onClick={() => {
                // The record answers "what do they still own?", so open
                // it before asking the question.
                if (!selected) onSelect();
                setConfirmingLeave(true);
              }}
            >
              Mark as left
            </button>
          ) : (
            <button className="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: partner.id, active: true })}>
              Bring back
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What a partner owns and what they have been credited.
 *
 * Every amount here is the one that was written at the time of the
 * sale, at the share that was then in force — this panel reads the
 * allocation rows, it does not re-split anything by today's
 * configuration. Reversals are shown as reversals rather than quietly
 * netted away: a partner asking why a figure moved is owed the entry
 * that moved it.
 */
function PartnerRecordPanel({ partnerId, onClose }: { partnerId: number; onClose: () => void }): JSX.Element {
  const record = usePartnerRecord(partnerId);

  if (record.isLoading) return <Loading />;
  if (record.error) return <ErrorBanner error={record.error} />;
  if (!record.data) return <p className="muted">No record for this partner.</p>;

  const { partner, ownedItems, recentAllocations, totalAllocatedMinor }: PartnerRecord = record.data;

  return (
    <div className="card col">
      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>
          {partner.name}
          {!partner.active && <span className="muted"> · left the business</span>}
        </h3>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="total-line grand">
        <span>Credited to date</span>
        <Money minor={totalAllocatedMinor} />
      </div>

      <h4 style={{ margin: '8px 0 0' }}>Owns today</h4>
      {ownedItems.length === 0 ? (
        <p className="muted">Nothing. No future sale will be credited to them.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <tbody>
              {ownedItems.map((owned) => (
                <tr key={owned.itemId}>
                  <td>{owned.itemName}</td>
                  <td className="num muted">{owned.shareBp / 100}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 style={{ margin: '8px 0 0' }}>Recent allocations</h4>
      {recentAllocations.length === 0 ? (
        <p className="muted">Nothing has been credited to them yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Share</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recentAllocations.map((allocation, index) => (
                <tr key={`${allocation.orderId}-${index}`} className={allocation.isReversal ? 'muted' : ''}>
                  <td>
                    {allocation.invoiceNo === null ? `#${allocation.orderId}` : `Invoice #${allocation.invoiceNo}`}
                    {allocation.isReversal && <span className="pill warn" style={{ marginLeft: 6 }}>Reversed</span>}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {allocation.closedAt === null ? 'not closed' : new Date(allocation.closedAt).toLocaleString()}
                    </div>
                  </td>
                  <td>{allocation.itemName}</td>
                  <td className="num">{allocation.qty}</td>
                  <td className="num muted">{allocation.shareBpSnapshot / 100}%</td>
                  <td className="num">
                    <Money minor={allocation.amountMinor} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

  const entries = splitEntries(shares);
  const totalBp = entries.reduce((total, entry) => total + entry.shareBp, 0);
  const balanced = totalBp === 10_000;

  if (ownership.isLoading) return <Loading />;

  return (
    <div className="col">
      <ErrorBanner error={setOwnership.error} />
      <SplitInputs
        partners={partners.data ?? []}
        shares={shares}
        onChange={(partnerId, shareBp) => setShares((current) => ({ ...current, [partnerId]: shareBp }))}
      />

      <div className="row">
        <SplitTotal totalBp={totalBp} />
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
