import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCreatePurchaseSource,
  useDeletePurchaseSource,
  usePurchaseSources,
  useRenamePurchaseSource,
  useSetPurchaseSourceActive,
  useSetPurchaseSourceCashDrawer,
} from '../api/hooks.js';
import type { PurchaseSource } from '../api/types.js';
import { ErrorBanner, Loading } from '../components/ui.tsx';

/**
 * The "Paid from" list: where a purchase's money came from — Cash drawer,
 * or a person who fronted it (a partner paying out of pocket). Used by the
 * Purchases ledger so the records show how much of the buying came from
 * the drawer vs. what someone else paid. A pure record — it never moves
 * the drawer or the sales.
 *
 * Put the one you use most (usually Cash drawer) first: the Purchases form
 * pre-selects the top of this list.
 */
export function PurchaseSourceConfigScreen(): JSX.Element {
  const sources = usePurchaseSources(true);
  const create = useCreatePurchaseSource();
  const [name, setName] = useState('');

  return (
    <div className="col" style={{ maxWidth: 640 }}>
      <div>
        <p className="page-kicker">Purchases</p>
        <h1 style={{ margin: 0 }}>Paid-from sources</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Where the money for a <Link to="/purchases">purchase</Link> came from — e.g. <strong>Cash drawer</strong> or <strong>Irfan</strong>. A
        record only; nothing here is taken off the drawer or your sales. The first in the list is pre-selected on the form, so put Cash
        drawer first. Tick <strong>“This is the cash drawer”</strong> on the one that is your till cash — that’s what the “remaining in
        drawer” figure subtracts from (only one source can be the drawer).
      </p>
      <ErrorBanner error={create.error} />

      <div className="card col">
        <h3 style={{ margin: 0 }}>Sources</h3>
        {sources.isLoading && <Loading />}
        {sources.data?.length === 0 && <p className="muted">No sources yet. Add your first below (start with Cash drawer).</p>}

        <div className="col">
          {sources.data?.map((source) => (
            <PurchaseSourceRow key={source.id} source={source} />
          ))}
        </div>

        <input placeholder="New source name" value={name} onChange={(event) => setName(event.target.value)} />
        <button
          className="primary"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate({ name: name.trim() }, { onSuccess: () => setName('') })}
        >
          Add source
        </button>
      </div>
    </div>
  );
}

function PurchaseSourceRow({ source }: { source: PurchaseSource }): JSX.Element {
  const rename = useRenamePurchaseSource();
  const setActive = useSetPurchaseSourceActive();
  const setCashDrawer = useSetPurchaseSourceCashDrawer();
  const remove = useDeletePurchaseSource();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(source.name);

  return (
    <div className="partner-row">
      <div className="row">
        {renaming ? (
          <input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} style={{ flex: 1 }} />
        ) : (
          <span style={{ flex: 1 }}>{source.name}</span>
        )}
        {source.isCashDrawer && <span className="pill ok">Cash drawer</span>}
        {!source.active && <span className="pill">Retired</span>}
      </div>

      {source.active && (
        <label className="row" style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={source.isCashDrawer}
            disabled={setCashDrawer.isPending}
            onChange={(event) => setCashDrawer.mutate({ id: source.id, isCashDrawer: event.target.checked })}
          />
          <span className="muted">This is the cash drawer</span>
        </label>
      )}

      <ErrorBanner error={rename.error ?? setActive.error ?? setCashDrawer.error ?? remove.error} />

      {renaming ? (
        <div className="row">
          <button
            className="primary"
            disabled={!draftName.trim() || rename.isPending}
            onClick={() => rename.mutate({ id: source.id, name: draftName.trim() }, { onSuccess: () => setRenaming(false) })}
          >
            Save name
          </button>
          <button
            className="ghost"
            onClick={() => {
              setDraftName(source.name);
              setRenaming(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="row partner-row-actions">
          <button
            className="ghost"
            onClick={() => {
              setDraftName(source.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          {source.active ? (
            <button className="ghost" disabled={remove.isPending} onClick={() => remove.mutate(source.id)}>
              Remove
            </button>
          ) : (
            <button className="ghost" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: source.id, active: true })}>
              Bring back
            </button>
          )}
        </div>
      )}
    </div>
  );
}
