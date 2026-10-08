import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreatePurchaseCategory, useDeletePurchaseCategory, usePurchaseCategories, useRenamePurchaseCategory, useSetPurchaseCategoryActive } from '../api/hooks.js';
import type { PurchaseCategory } from '../api/types.js';
import { ErrorBanner, Loading } from '../components/ui.tsx';

/**
 * The owner's own list of purchase categories (Meat, Vegetables, Gas,
 * Tawa Chicken, …), used by the Purchases ledger. Deliberately separate
 * from the MENU categories: a purchase like gas or packaging maps to no
 * dish, and a menu rename must never rewrite purchase history.
 *
 * A category nothing has been recorded against can be deleted outright; a
 * category already used by a purchase is retired instead, so it leaves
 * the picker but stays attached to the history that references it.
 */
export function PurchaseCategoryConfigScreen(): JSX.Element {
  const categories = usePurchaseCategories(true);
  const create = useCreatePurchaseCategory();
  const [name, setName] = useState('');

  return (
    <div className="col" style={{ maxWidth: 640 }}>
      <div>
        <p className="page-kicker">Purchases</p>
        <h1 style={{ margin: 0 }}>Purchase categories</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        The categories you file purchases under, so <Link to="/purchases">Purchases</Link> and the reports can show how much was
        spent on each. Your own list — set it up however you buy (Meat, Vegetables, Gas, packaging…), not the menu sections.
      </p>
      <ErrorBanner error={create.error} />

      <div className="card col">
        <h3 style={{ margin: 0 }}>Categories</h3>
        {categories.isLoading && <Loading />}
        {categories.data?.length === 0 && <p className="muted">No categories yet. Add your first below.</p>}

        <div className="col">
          {categories.data?.map((category) => (
            <PurchaseCategoryRow key={category.id} category={category} />
          ))}
        </div>

        <input placeholder="New category name" value={name} onChange={(event) => setName(event.target.value)} />
        <button
          className="primary"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate({ name: name.trim() }, { onSuccess: () => setName('') })}
        >
          Add category
        </button>
      </div>
    </div>
  );
}

function PurchaseCategoryRow({ category }: { category: PurchaseCategory }): JSX.Element {
  const rename = useRenamePurchaseCategory();
  const setActive = useSetPurchaseCategoryActive();
  const remove = useDeletePurchaseCategory();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(category.name);

  return (
    <div className="partner-row">
      <div className="row">
        {renaming ? (
          <input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} style={{ flex: 1 }} />
        ) : (
          <span style={{ flex: 1 }}>{category.name}</span>
        )}
        {!category.active && <span className="pill">Retired</span>}
      </div>

      <ErrorBanner error={rename.error ?? setActive.error ?? remove.error} />

      {renaming ? (
        <div className="row">
          <button
            className="primary"
            disabled={!draftName.trim() || rename.isPending}
            onClick={() => rename.mutate({ id: category.id, name: draftName.trim() }, { onSuccess: () => setRenaming(false) })}
          >
            Save name
          </button>
          <button
            className="ghost"
            onClick={() => {
              setDraftName(category.name);
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
              setDraftName(category.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          {category.active ? (
            // Remove deletes an unused category outright, or retires one
            // that already has purchases — the server decides which.
            <button className="ghost" disabled={remove.isPending} onClick={() => remove.mutate(category.id)}>
              Remove
            </button>
          ) : (
            <button className="ghost" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: category.id, active: true })}>
              Bring back
            </button>
          )}
        </div>
      )}
    </div>
  );
}
