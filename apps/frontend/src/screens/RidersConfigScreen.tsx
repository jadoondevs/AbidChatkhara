import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreateRider, useRenameRider, useRiders, useSetRiderActive } from '../api/hooks.js';
import type { Rider } from '../api/types.js';
import { ErrorBanner, Loading } from '../components/ui.tsx';

/**
 * Delivery riders: the people a delivery order is assigned to, and whom a
 * delivery charge is owed to. The delivery counterpart of the waiters in
 * Settings → Users, kept as their own list because a rider does not sign
 * in to the till — they are named, not given an account.
 *
 * Retiring a rider (never deleting) keeps every past delivery pointing at
 * a real name, the same reason a partner is marked as left rather than
 * removed.
 */
export function RidersConfigScreen(): JSX.Element {
  const riders = useRiders(true);
  const createRider = useCreateRider();
  const [name, setName] = useState('');

  return (
    <div className="col" style={{ maxWidth: 640 }}>
      <div>
        <p className="page-kicker">Delivery</p>
        <h1 style={{ margin: 0 }}>Riders</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        The riders who carry delivery orders. A delivery order is assigned to one, and any delivery charge on it is owed to that
        rider — the delivery version of the waiter a dine-in order is attributed to. Separate from{' '}
        <Link to="/settings">Settings → Users</Link>, who are the accounts that sign in to this till.
      </p>
      <ErrorBanner error={createRider.error} />

      <div className="card col">
        <h3 style={{ margin: 0 }}>Riders</h3>
        {riders.isLoading && <Loading />}
        {riders.data?.length === 0 && <p className="muted">No riders yet. Add one below.</p>}

        <div className="col">
          {riders.data?.map((rider) => (
            <RiderRow key={rider.id} rider={rider} />
          ))}
        </div>

        <input placeholder="New rider name" value={name} onChange={(event) => setName(event.target.value)} />
        <button
          className="primary"
          disabled={!name.trim() || createRider.isPending}
          onClick={() => createRider.mutate({ name: name.trim() }, { onSuccess: () => setName('') })}
        >
          Add rider
        </button>
      </div>
    </div>
  );
}

function RiderRow({ rider }: { rider: Rider }): JSX.Element {
  const rename = useRenameRider();
  const setActive = useSetRiderActive();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(rider.name);

  return (
    <div className="partner-row">
      <div className="row">
        {renaming ? (
          <input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} style={{ flex: 1 }} />
        ) : (
          <span style={{ flex: 1 }}>{rider.name}</span>
        )}
        {!rider.active && <span className="pill">Retired</span>}
      </div>

      <ErrorBanner error={rename.error ?? setActive.error} />

      {renaming ? (
        <div className="row">
          <button
            className="primary"
            disabled={!draftName.trim() || rename.isPending}
            onClick={() => rename.mutate({ id: rider.id, name: draftName.trim() }, { onSuccess: () => setRenaming(false) })}
          >
            Save name
          </button>
          <button
            className="ghost"
            onClick={() => {
              setDraftName(rider.name);
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
              setDraftName(rider.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          {rider.active ? (
            <button className="ghost" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: rider.id, active: false })}>
              Retire
            </button>
          ) : (
            <button className="ghost" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: rider.id, active: true })}>
              Bring back
            </button>
          )}
        </div>
      )}
    </div>
  );
}
