import { paisa, type Paisa } from '@pos/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCreatePurchase,
  useOpenShift,
  usePartners,
  usePurchaseCategories,
  usePurchaseReport,
  usePurchaseSources,
  useVoidPurchase,
} from '../api/hooks.js';
import type { Purchase, PurchaseReport } from '../api/types.js';
import { PurchaseBySource, PurchasePartnerMatrix } from '../components/PurchaseSummary.tsx';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';

/** Local calendar day as YYYY-MM-DD — the day the restaurant is having,
 * never the UTC day. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The daily purchase ledger — what the restaurant bought today, for how
 * much, for which partner, under which category, and paid from where. A
 * pure record: nothing here is subtracted from sales or the cash drawer.
 *
 * It records against the open shift when there is one (so a shift's
 * purchases are correct across midnight, like its orders); with no shift
 * open it still records, filed under today's date.
 */
export function PurchasesScreen(): JSX.Element {
  const openShift = useOpenShift();
  const partners = usePartners();
  const categories = usePurchaseCategories();
  const sources = usePurchaseSources();

  const create = useCreatePurchase();

  const [partnerId, setPartnerId] = useState<number | ''>('');
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [sourceId, setSourceId] = useState<number | ''>('');
  const [description, setDescription] = useState('');
  const [amountMinor, setAmountMinor] = useState<Paisa>(paisa(0));
  const [amountValid, setAmountValid] = useState(true);
  const [note, setNote] = useState('');

  // Pre-select the first "paid from" source (the owner puts Cash drawer
  // first). Only fills an empty field, so it never fights a deliberate pick.
  useEffect(() => {
    if (sourceId === '' && (sources.data?.length ?? 0) > 0) setSourceId(sources.data![0]!.id);
  }, [sources.data, sourceId]);

  // The ledger shown below is this shift's if one is open, else today's —
  // the same records the shift report and the Reports → Purchases tab show.
  const today = localDay(new Date());
  const scope = openShift.data ? { shiftId: openShift.data.id } : { date: today };
  const report = usePurchaseReport(scope);

  const canCreate = partnerId !== '' && categoryId !== '' && sourceId !== '' && amountMinor > 0 && amountValid;

  const submit = () => {
    if (!canCreate || create.isPending) return;
    create.mutate(
      {
        partnerId: Number(partnerId),
        categoryId: Number(categoryId),
        amountMinor,
        // canCreate guarantees a source is selected, so always send it.
        sourceId: Number(sourceId),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          // Keep partner, category and source — purchases come in runs —
          // but clear the amount, description and note for the next entry.
          setAmountMinor(paisa(0));
          setDescription('');
          setNote('');
        },
      },
    );
  };

  const noPartners = !partners.isLoading && (partners.data ?? []).length === 0;
  const noCategories = !categories.isLoading && (categories.data ?? []).length === 0;
  const noSources = !sources.isLoading && (sources.data ?? []).length === 0;

  return (
    <div className="col">
      <div className="row">
        <div style={{ flex: 1 }}>
          <p className="page-kicker">Daily purchases</p>
          <h1 style={{ margin: 0 }}>Purchases</h1>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        {openShift.data ? (
          <>
            Recording to the open shift <strong>#{openShift.data.id}</strong>.
          </>
        ) : (
          <>No shift open — purchases are recorded under today’s date.</>
        )}{' '}
        A record only — nothing here is taken off your sales or the drawer.
      </p>

      <ErrorBanner error={create.error} />

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        {/* Entry form */}
        <div className="card col">
          <h3 style={{ margin: 0 }}>Add a purchase</h3>

          {noCategories && (
            <p className="muted">
              No purchase categories yet. Add some under <Link to="/config/purchase-categories">Settings → Purchase categories</Link> first.
            </p>
          )}
          {noSources && (
            <p className="muted">
              No “paid from” sources yet. Add them (start with Cash drawer) under{' '}
              <Link to="/config/purchase-sources">Settings → Paid-from sources</Link> first.
            </p>
          )}
          {noPartners && (
            <p className="muted">
              No partners yet. Add them under <Link to="/config/partners">Partners</Link> first.
            </p>
          )}

          <div>
            <label htmlFor="purchase-partner">Partner</label>
            <select id="purchase-partner" value={partnerId} onChange={(event) => setPartnerId(event.target.value === '' ? '' : Number(event.target.value))}>
              <option value="">Select a partner…</option>
              {partners.data?.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {partner.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="purchase-category">Category</label>
            <select id="purchase-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value === '' ? '' : Number(event.target.value))}>
              <option value="">Select a category…</option>
              {categories.data?.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="purchase-source">Paid from</label>
            <select id="purchase-source" value={sourceId} onChange={(event) => setSourceId(event.target.value === '' ? '' : Number(event.target.value))}>
              <option value="">Select a source…</option>
              {sources.data?.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="purchase-description">What was bought (optional)</label>
            <input id="purchase-description" maxLength={200} placeholder="e.g. Chicken 10kg" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>

          <div>
            <label htmlFor="purchase-amount">Amount (Rs)</label>
            <MoneyInput id="purchase-amount" valueMinor={amountMinor} onChange={setAmountMinor} onValidityChange={setAmountValid} />
          </div>

          <div>
            <label htmlFor="purchase-note">Note (optional)</label>
            <input id="purchase-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>

          <button className="primary big" disabled={!canCreate || create.isPending} onClick={submit}>
            {create.isPending ? 'Saving…' : 'Add purchase'}
          </button>
        </div>

        {/* Running totals for the scope shown */}
        <div className="card col">
          <h3 style={{ margin: 0 }}>{openShift.data ? `This shift (#${openShift.data.id})` : 'Today'}</h3>
          {report.isLoading && <Loading />}
          {report.data && (
            <>
              <div className="total-line grand">
                <span>Total purchases</span>
                <Money minor={report.data.totalMinor} />
              </div>
              <p className="muted" style={{ marginTop: 0 }}>
                {report.data.count} {report.data.count === 1 ? 'purchase' : 'purchases'}
              </p>

              <h4 style={{ marginBottom: 4 }}>By category &amp; partner</h4>
              <PurchasePartnerMatrix report={report.data} />

              <h4 style={{ marginBottom: 4 }}>Paid from</h4>
              <PurchaseBySource report={report.data} />
            </>
          )}
        </div>
      </div>

      {/* The individual rows, SPLIT into one list per partner — side by
          side, each with its own subtotal. */}
      <ErrorBanner error={report.error} />
      {report.data && report.data.purchases.length === 0 && (
        <div className="card">
          <h3 style={{ margin: 0 }}>Purchases {openShift.data ? 'this shift' : 'today'}</h3>
          <p className="muted">No purchases recorded yet.</p>
        </div>
      )}
      {report.data && report.data.purchases.length > 0 && <PurchasesByPartnerList report={report.data} openShift={openShift.data !== null && openShift.data !== undefined} />}
    </div>
  );
}

/** The purchase list split into one column per partner, side by side —
 * each partner's own purchases with a subtotal, which is what "divide the
 * list, one side per partner" means. */
function PurchasesByPartnerList({ report, openShift }: { report: PurchaseReport; openShift: boolean }): JSX.Element {
  return (
    <div className="col">
      <h3 style={{ margin: 0 }}>Purchases {openShift ? 'this shift' : 'today'} — by partner</h3>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, report.byPartner.length)}, minmax(300px, 1fr))`, alignItems: 'start' }}>
        {report.byPartner.map((partner) => (
          <div key={partner.id} className="card col">
            <div className="row" style={{ alignItems: 'baseline' }}>
              <h4 style={{ margin: 0, flex: 1 }}>{partner.name}</h4>
              <strong>
                <Money minor={partner.totalMinor} />
              </strong>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              {partner.count} {partner.count === 1 ? 'purchase' : 'purchases'}
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Category</th>
                    <th>What</th>
                    <th>Paid from</th>
                    <th className="num">Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {report.purchases
                    .filter((purchase) => purchase.partnerId === partner.id)
                    .map((purchase) => (
                      <PurchaseRow key={purchase.id} purchase={purchase} />
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PurchaseRow({ purchase }: { purchase: Purchase }): JSX.Element {
  const voidPurchase = useVoidPurchase();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <tr>
      <td>{new Date(purchase.createdAt).toLocaleString()}</td>
      <td>{purchase.categoryName}</td>
      <td>
        {purchase.description ?? <span className="muted">—</span>}
        {purchase.note && <div className="muted line-modifiers">{purchase.note}</div>}
      </td>
      <td>{purchase.sourceName ?? <span className="muted">—</span>}</td>
      <td className="num">
        <Money minor={purchase.amountMinor} />
      </td>
      <td>
        {voiding ? (
          <div className="col" style={{ gap: 4 }}>
            <input autoFocus placeholder="Reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            <ErrorBanner error={voidPurchase.error} />
            <div className="row">
              <button
                className="ghost"
                disabled={!reason.trim() || voidPurchase.isPending}
                onClick={() => voidPurchase.mutate({ id: purchase.id, reason: reason.trim() }, { onSuccess: () => setVoiding(false) })}
              >
                Confirm void
              </button>
              <button className="ghost" onClick={() => setVoiding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="ghost" onClick={() => setVoiding(true)}>
            Void
          </button>
        )}
      </td>
    </tr>
  );
}
