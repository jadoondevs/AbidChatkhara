import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCategories,
  useClearItemModifierPrice,
  useCreateCategory,
  useCreateItem,
  useCreateModifier,
  useCreateModifierGroup,
  useItemModifierGroups,
  useItemModifierPrices,
  useItemsWithoutOwnership,
  useLinkModifierGroup,
  useMenu,
  useModifierGroups,
  useModifiers,
  useRemoveItem,
  useSetItemAvailability,
  useSetItemModifierPrice,
  useSetItemPrice,
  useUnlinkModifierGroup,
  useUpdateItem,
} from '../api/hooks.js';
import type { MenuItem, ModifierGroup } from '../api/types.js';
import { ErrorBanner, Loading, Modal, Money, MoneyInput } from '../components/ui.tsx';

/**
 * Screen 7: the menu, and everything about it.
 *
 * Every detail an item has is editable here — its name, its price, the
 * category it sits in, whether it is available tonight, which modifier
 * groups it offers and what each of those costs on this particular item.
 * Nothing about a restaurant's menu is compiled in, so nothing about it
 * should need a developer.
 *
 * Two edits that look alike are deliberately different underneath. A
 * price change writes a NEW effective-dated row rather than editing the
 * old one, so past orders keep the price they were rung up at. A rename
 * updates in place, and is safe for the same reason from the other
 * direction: a sold line snapshots the name it was sold under, so
 * correcting a typo does not rewrite last month's bills.
 */
export function MenuConfigScreen(): JSX.Element {
  const categories = useCategories(true);
  const menu = useMenu();
  // An item nobody owns cannot be sold at all — the sale fails at
  // allocation, at the payment screen, with an error a cashier can do
  // nothing about. Flagging it here puts the problem where the person
  // who can fix it is already standing.
  const unowned = useItemsWithoutOwnership();
  const createCategory = useCreateCategory();
  const createItem = useCreateItem();
  const setPrice = useSetItemPrice();
  const setAvailability = useSetItemAvailability();
  const updateItem = useUpdateItem();
  const removeItem = useRemoveItem();

  const [categoryName, setCategoryName] = useState('');
  const [itemName, setItemName] = useState('');
  const [itemCategoryId, setItemCategoryId] = useState<number | ''>('');
  const [editing, setEditing] = useState<MenuItem | null>(null);
  const [modifiersFor, setModifiersFor] = useState<MenuItem | null>(null);
  const [removing, setRemoving] = useState<MenuItem | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  // What the server did the last time an item was taken off the menu.
  // Deleting and retiring look the same from the button, so the screen
  // has to say which one happened.
  const [removalNote, setRemovalNote] = useState<string | null>(null);

  const categoryName_ = (id: number) => categories.data?.find((category) => category.id === id)?.name ?? String(id);

  return (
    <div className="col menu-screen">
      <div className="row">
        <div style={{ flex: 1 }}>
          <p className="page-kicker">Catalog</p>
          <h1 style={{ margin: 0 }}>Menu</h1>
        </div>
        <button onClick={() => setGroupsOpen(true)}>Modifier groups</button>
      </div>

      <ErrorBanner
        error={createCategory.error ?? createItem.error ?? setPrice.error ?? setAvailability.error ?? updateItem.error ?? removeItem.error}
      />
      {removalNote && <div className="blocked-notice info">{removalNote}</div>}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card col">
          <h3 style={{ margin: 0 }}>Add category</h3>
          <input placeholder="Category name" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} />
          <button
            className="primary"
            disabled={!categoryName.trim() || createCategory.isPending}
            onClick={() => createCategory.mutate({ name: categoryName.trim() }, { onSuccess: () => setCategoryName('') })}
          >
            Add category
          </button>
        </div>

        <div className="card col">
          <h3 style={{ margin: 0 }}>Add item</h3>
          <select value={itemCategoryId} onChange={(event) => setItemCategoryId(event.target.value === '' ? '' : Number(event.target.value))}>
            <option value="">Category…</option>
            {categories.data?.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <input placeholder="Item name" value={itemName} onChange={(event) => setItemName(event.target.value)} />
          <button
            className="primary"
            disabled={!itemName.trim() || itemCategoryId === '' || createItem.isPending}
            onClick={() =>
              createItem.mutate({ categoryId: Number(itemCategoryId), name: itemName.trim() }, { onSuccess: () => setItemName('') })
            }
          >
            Add item
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: 0 }}>Items</h3>
        {menu.isLoading && <Loading />}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th className="num">Price</th>
                <th>Options</th>
                <th>Tonight</th>
                <th className="num">Edit</th>
              </tr>
            </thead>
            <tbody>
              {menu.data?.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    {unowned.data?.includes(item.id) && (
                      <div>
                        <Link to="/config/partners" className="pill warn">
                          No owner — can't be sold
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="muted">{categoryName_(item.categoryId)}</td>
                  <td className="num">
                    {item.priceMinor === null ? <span className="pill warn">No price</span> : <Money minor={item.priceMinor} />}
                  </td>
                  <td>
                    <button className="ghost" onClick={() => setModifiersFor(item)}>
                      Options…
                    </button>
                  </td>
                  <td>
                    {/* "Available" is tonight's question — we are out of
                        it — and stays separate from taking the item off
                        the menu, which is what Remove does. */}
                    <button onClick={() => setAvailability.mutate({ itemId: item.id, available: !item.available })}>
                      {item.available ? 'Available' : 'Unavailable'}
                    </button>
                  </td>
                  <td className="num menu-row-actions">
                    <button className="ghost" onClick={() => setEditing(item)}>
                      Edit
                    </button>
                    <button className="ghost" onClick={() => setRemoving(item)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {menu.data?.length === 0 && (
                <tr>
                  <td className="muted">No items yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && <ItemDialog item={editing} onClose={() => setEditing(null)} />}
      {modifiersFor && <ItemModifiersDialog item={modifiersFor} onClose={() => setModifiersFor(null)} />}
      {groupsOpen && <ModifierGroupsDialog onClose={() => setGroupsOpen(false)} />}
      {removing && (
        <RemoveItemDialog
          item={removing}
          onClose={() => setRemoving(null)}
          onDone={(outcome, name) => {
            setRemoving(null);
            setRemovalNote(
              outcome === 'deleted'
                ? `“${name}” was never sold, so it has been deleted outright.`
                : `“${name}” has been sold before, so it is retired rather than deleted — it is off the till and still in the reports.`,
            );
          }}
        />
      )}
    </div>
  );
}

/** Name, category and price in one place, because they are one thought:
 * "this item is wrong". */
function ItemDialog({ item, onClose }: { item: MenuItem; onClose: () => void }): JSX.Element {
  const categories = useCategories(true);
  const updateItem = useUpdateItem();
  const setPrice = useSetItemPrice();

  const [name, setName] = useState(item.name);
  const [categoryId, setCategoryId] = useState(item.categoryId);
  const [priceMinor, setPriceMinor] = useState<Paisa>(item.priceMinor ?? paisa(0));

  const pending = updateItem.isPending || setPrice.isPending;
  const detailsChanged = name.trim() !== item.name || categoryId !== item.categoryId;
  const priceChanged = priceMinor !== (item.priceMinor ?? paisa(0));

  const save = () => {
    if (!name.trim() || pending) return;
    const afterDetails = () => {
      if (!priceChanged) {
        onClose();
        return;
      }
      setPrice.mutate({ itemId: item.id, priceMinor }, { onSuccess: onClose });
    };
    if (detailsChanged) {
      updateItem.mutate({ itemId: item.id, name: name.trim(), categoryId }, { onSuccess: afterDetails });
      return;
    }
    afterDetails();
  };

  return (
    <Modal title={`Edit ${item.name}`} onClose={onClose}>
      <div className="col">
        <ErrorBanner error={updateItem.error ?? setPrice.error} />

        <div>
          <label htmlFor="item-name">Item name</label>
          <input id="item-name" autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          <p className="muted field-hint">
            Safe to correct at any time — a sold line keeps the name it was sold under, so this never rewrites an old bill.
          </p>
        </div>

        <div>
          <label htmlFor="item-category">Category</label>
          <select id="item-category" value={categoryId} onChange={(event) => setCategoryId(Number(event.target.value))}>
            {categories.data?.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="item-price">Price</label>
          <MoneyInput id="item-price" valueMinor={priceMinor} onChange={setPriceMinor} />
          <p className="muted field-hint">A new price applies from now. Orders already taken keep the price they were rung up at.</p>
        </div>

        {!item.active && (
          <div className="blocked-notice">
            <strong>This item is retired.</strong>
            <p className="muted">It has been sold before, so it stays in the reports. Bring it back to the till below.</p>
            <button onClick={() => updateItem.mutate({ itemId: item.id, active: true }, { onSuccess: onClose })}>Put back on the menu</button>
          </div>
        )}

        <button className="primary big" disabled={!name.trim() || pending} onClick={save}>
          {pending ? 'Saving…' : 'Save item'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Which option groups this item offers, and what each option costs on
 * THIS item.
 *
 * The group is shared — one "Half / Full" hangs off every karahi — but
 * the uplift is not: Full is worth a different amount on each of them.
 * A blank price here means "use the group's own default".
 */
function ItemModifiersDialog({ item, onClose }: { item: MenuItem; onClose: () => void }): JSX.Element {
  const allGroups = useModifierGroups();
  const attached = useItemModifierGroups(item.id);
  const link = useLinkModifierGroup();
  const unlink = useUnlinkModifierGroup();

  const attachedIds = new Set((attached.data ?? []).map((group) => group.id));

  return (
    <Modal title={`Options for ${item.name}`} wide onClose={onClose}>
      <div className="col">
        <ErrorBanner error={link.error ?? unlink.error} />
        <p className="muted" style={{ margin: 0 }}>
          A group with one required choice becomes a size: the till asks before the item joins the bill.
        </p>

        {allGroups.isLoading && <Loading />}
        {allGroups.data?.length === 0 && (
          <p className="muted">No modifier groups exist yet. Create one from the Menu screen&apos;s “Modifier groups” button.</p>
        )}

        {allGroups.data?.map((group) => (
          <div key={group.id} className="card col option-group">
            <div className="row">
              <div style={{ flex: 1 }}>
                <strong>{group.name}</strong>{' '}
                <span className="muted">
                  {group.minSelect === 1 && group.maxSelect === 1
                    ? 'one required choice'
                    : `choose ${group.minSelect}–${group.maxSelect}`}
                </span>
              </div>
              <button
                disabled={link.isPending || unlink.isPending}
                onClick={() =>
                  attachedIds.has(group.id)
                    ? unlink.mutate({ itemId: item.id, groupId: group.id })
                    : link.mutate({ itemId: item.id, groupId: group.id })
                }
              >
                {attachedIds.has(group.id) ? 'Remove from item' : 'Add to item'}
              </button>
            </div>

            {attachedIds.has(group.id) && <GroupPrices item={item} group={group} />}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Each option in an attached group, with what it costs on this item. */
function GroupPrices({ item, group }: { item: MenuItem; group: ModifierGroup }): JSX.Element {
  const modifiers = useModifiers(group.id);
  const overrides = useItemModifierPrices(item.id);
  const setPrice = useSetItemModifierPrice();
  const clearPrice = useClearItemModifierPrice();
  const [edits, setEdits] = useState<Record<number, Paisa>>({});

  const overrideFor = (modifierId: number) => overrides.data?.find((row) => row.modifierId === modifierId)?.priceDeltaMinor;

  return (
    <div className="col option-prices">
      <ErrorBanner error={setPrice.error ?? clearPrice.error} />
      {modifiers.data?.map((modifier) => {
        const override = overrideFor(modifier.id);
        const current = edits[modifier.id] ?? override ?? modifier.priceDeltaMinor;
        return (
          <div key={modifier.id} className="row option-price-row">
            <span style={{ flex: 1 }}>{modifier.name}</span>
            <MoneyInput valueMinor={current} onChange={(next) => setEdits((all) => ({ ...all, [modifier.id]: next }))} />
            <button
              disabled={setPrice.isPending || current === (override ?? modifier.priceDeltaMinor)}
              onClick={() => setPrice.mutate({ itemId: item.id, modifierId: modifier.id, priceDeltaMinor: current })}
            >
              Set
            </button>
            {override === undefined ? (
              <span className="muted field-hint" style={{ margin: 0, minWidth: 96 }}>
                group default
              </span>
            ) : (
              <button
                className="ghost"
                disabled={clearPrice.isPending}
                onClick={() => {
                  // Drop this modifier's pending edit so the row falls
                  // back to showing the group default again.
                  setEdits((all) => Object.fromEntries(Object.entries(all).filter(([key]) => Number(key) !== modifier.id)));
                  clearPrice.mutate({ itemId: item.id, modifierId: modifier.id });
                }}
              >
                Use default
              </button>
            )}
          </div>
        );
      })}
      {modifiers.data?.length === 0 && <p className="muted field-hint">This group has no options yet.</p>}
    </div>
  );
}

/** Creating the groups themselves — sizes, spice levels, add-ons. */
function ModifierGroupsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const groups = useModifierGroups();
  const createGroup = useCreateModifierGroup();
  const createModifier = useCreateModifier();

  const [name, setName] = useState('');
  const [required, setRequired] = useState(true);
  const [optionFor, setOptionFor] = useState<number | ''>('');
  const [optionName, setOptionName] = useState('');
  const [optionDelta, setOptionDelta] = useState<Paisa>(paisa(0));

  return (
    <Modal title="Modifier groups" wide onClose={onClose}>
      <div className="col">
        <ErrorBanner error={createGroup.error ?? createModifier.error} />

        <div className="card col">
          <h3 style={{ margin: 0 }}>New group</h3>
          <div>
            <label htmlFor="group-name">Group name</label>
            <input id="group-name" placeholder="Half / Full" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
            Exactly one must be chosen — this makes it a size
          </label>
          <p className="muted field-hint" style={{ marginTop: 0 }}>
            Leave it unticked for extras a customer may pick any number of, like add-ons.
          </p>
          <button
            className="primary"
            disabled={!name.trim() || createGroup.isPending}
            onClick={() =>
              createGroup.mutate(
                { name: name.trim(), minSelect: required ? 1 : 0, maxSelect: required ? 1 : 5 },
                { onSuccess: () => setName('') },
              )
            }
          >
            Create group
          </button>
        </div>

        <div className="card col">
          <h3 style={{ margin: 0 }}>Add an option</h3>
          <div>
            <label htmlFor="option-group">Group</label>
            <select id="option-group" value={optionFor} onChange={(event) => setOptionFor(event.target.value === '' ? '' : Number(event.target.value))}>
              <option value="">Choose a group…</option>
              {groups.data?.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="option-name">Option name</label>
            <input id="option-name" placeholder="Full" value={optionName} onChange={(event) => setOptionName(event.target.value)} />
          </div>
          <div>
            <label htmlFor="option-delta">Default price change</label>
            <MoneyInput id="option-delta" valueMinor={optionDelta} onChange={setOptionDelta} />
            <p className="muted field-hint">
              What this option adds by default. Any item can override it — set the item&apos;s own price under Options.
            </p>
          </div>
          <button
            className="primary"
            disabled={!optionName.trim() || optionFor === '' || createModifier.isPending}
            onClick={() =>
              createModifier.mutate(
                { groupId: Number(optionFor), name: optionName.trim(), priceDeltaMinor: optionDelta },
                {
                  onSuccess: () => {
                    setOptionName('');
                    setOptionDelta(paisa(0));
                  },
                },
              )
            }
          >
            Add option
          </button>
        </div>

        <div className="card">
          <h3 style={{ margin: 0 }}>Existing groups</h3>
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Choice</th>
                <th>Options</th>
              </tr>
            </thead>
            <tbody>
              {groups.data?.map((group) => (
                <GroupRow key={group.id} group={group} />
              ))}
              {groups.data?.length === 0 && (
                <tr>
                  <td className="muted">None yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

function GroupRow({ group }: { group: ModifierGroup }): JSX.Element {
  const modifiers = useModifiers(group.id);
  return (
    <tr>
      <td>
        <strong>{group.name}</strong>
      </td>
      <td className="muted">
        {group.minSelect === 1 && group.maxSelect === 1 ? 'one required' : `${group.minSelect}–${group.maxSelect}`}
      </td>
      <td className="muted">
        {modifiers.data?.map((modifier) => modifier.name).join(', ') || <span className="muted">no options yet</span>}
      </td>
    </tr>
  );
}

/**
 * Taking an item off the menu. Whether that deletes it or retires it is
 * the server's decision, made from whether it has ever been sold — so
 * the dialog explains both outcomes before, and says which happened
 * after.
 */
function RemoveItemDialog({
  item,
  onClose,
  onDone,
}: {
  item: MenuItem;
  onClose: () => void;
  onDone: (outcome: 'deleted' | 'retired', name: string) => void;
}): JSX.Element {
  const removeItem = useRemoveItem();

  return (
    <Modal title={`Remove ${item.name}?`} onClose={onClose}>
      <div className="col">
        <ErrorBanner error={removeItem.error} />
        <p style={{ margin: 0 }}>
          If this item has never been sold it is deleted outright. If it has, it is retired instead — taken off the till but kept in every
          report and on every bill that sold it, because that history is not ours to rewrite.
        </p>
        <button
          className="danger big"
          disabled={removeItem.isPending}
          onClick={() => removeItem.mutate(item.id, { onSuccess: (result) => onDone(result.outcome, item.name) })}
        >
          {removeItem.isPending ? 'Removing…' : 'Remove from menu'}
        </button>
        <button disabled={removeItem.isPending} onClick={onClose}>
          Keep it
        </button>
      </div>
    </Modal>
  );
}
