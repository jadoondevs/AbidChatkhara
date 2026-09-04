import { add, paisa, sub, type Paisa } from '@pos/shared';
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
  useUpdateModifierGroup,
} from '../api/hooks.js';
import type { MenuItem, Modifier, ModifierGroup, ModifierPricingMode } from '../api/types.js';
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
                {/* "Options…" was its own button and its own dialog,
                    separate from Edit — so a manager who clicked Edit to
                    change a size never found the sizes. Options now live
                    inside Edit; this column is a read-only summary. */}
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
                  <td className="muted">
                    <ItemOptionsSummary itemId={item.id} />
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

/** The read-only "Options" cell in the item table: the names of the
 * groups an item offers, so the list shows at a glance which items have
 * sizes without opening each one. Configuring them is done in Edit. */
function ItemOptionsSummary({ itemId }: { itemId: number }): JSX.Element {
  const groups = useItemModifierGroups(itemId);
  const names = (groups.data ?? []).map((group) => group.name);
  if (names.length === 0) return <span className="muted">—</span>;
  return <>{names.join(', ')}</>;
}

/**
 * Everything about one item, in one dialog: name, category, base price,
 * availability, and its modifiers.
 *
 * The modifiers used to live behind a separate "Options…" button with
 * its own dialog, so a manager who opened Edit to change a size never
 * found the size. They are folded in here now, and their prices are
 * shown as the FINAL price of the item at that size — not a delta the
 * manager has to add to the base in their head.
 */
function ItemDialog({ item, onClose }: { item: MenuItem; onClose: () => void }): JSX.Element {
  const categories = useCategories(true);
  const updateItem = useUpdateItem();
  const setPrice = useSetItemPrice();
  const setAvailability = useSetItemAvailability();

  const [name, setName] = useState(item.name);
  const [categoryId, setCategoryId] = useState(item.categoryId);
  const [priceMinor, setPriceMinor] = useState<Paisa>(item.priceMinor ?? paisa(0));
  // Availability toggles on its own request, so it needs its own live
  // state — the `item` prop is the snapshot the row was opened with and
  // does not update underneath the open dialog.
  const [available, setAvailable] = useState(item.available);

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

  const toggleAvailable = () => {
    const next = !available;
    setAvailable(next);
    setAvailability.mutate({ itemId: item.id, available: next });
  };

  return (
    <Modal title={`Edit ${item.name}`} wide onClose={onClose}>
      <div className="col">
        <ErrorBanner error={updateItem.error ?? setPrice.error ?? setAvailability.error} />

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
          <label htmlFor="item-price">Base price</label>
          <MoneyInput id="item-price" valueMinor={priceMinor} onChange={setPriceMinor} />
          <p className="muted field-hint">
            The price with no size chosen. A new price applies from now; orders already taken keep the price they were rung up at.
          </p>
        </div>

        <div>
          <label>Availability</label>
          <div>
            <button onClick={toggleAvailable}>{available ? 'Available tonight' : 'Unavailable tonight'}</button>
            <p className="muted field-hint">Whether the kitchen can make it right now. Separate from taking it off the menu.</p>
          </div>
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

        <ItemModifiers item={item} basePriceMinor={item.priceMinor ?? paisa(0)} basePriceDirty={priceChanged} />
      </div>
    </Modal>
  );
}

/**
 * The Modifiers section of the item editor: the size and add-on groups
 * this item offers, each with its options and their per-item prices.
 *
 * A group is a reusable definition — one "Size" is shared across every
 * karahi — so this both lets an item reuse an existing group and create
 * a brand-new one, without leaving the item editor.
 */
function ItemModifiers({
  item,
  basePriceMinor,
  basePriceDirty,
}: {
  item: MenuItem;
  basePriceMinor: Paisa;
  basePriceDirty: boolean;
}): JSX.Element {
  const allGroups = useModifierGroups();
  const attached = useItemModifierGroups(item.id);
  const link = useLinkModifierGroup();
  const unlink = useUnlinkModifierGroup();
  const createGroup = useCreateModifierGroup();

  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupRequired, setNewGroupRequired] = useState(true);

  const attachedIds = new Set((attached.data ?? []).map((group) => group.id));
  const attachedGroups = (allGroups.data ?? []).filter((group) => attachedIds.has(group.id));
  const reusableGroups = (allGroups.data ?? []).filter((group) => !attachedIds.has(group.id));

  const addGroup = async () => {
    // "Required, choose one" IS the "this is a size" signal here, and the
    // hint above promises final-price behaviour for it — so a required
    // group is a variant (final price) and an optional one an add-on.
    const created = await createGroup.mutateAsync(
      newGroupRequired
        ? { name: newGroupName.trim(), minSelect: 1, maxSelect: 1, pricingMode: 'variant' }
        : { name: newGroupName.trim(), minSelect: 0, maxSelect: 5, pricingMode: 'add_on' },
    );
    await link.mutateAsync({ itemId: item.id, groupId: created.id });
    setNewGroupName('');
  };

  return (
    <div className="col item-modifiers">
      <h3 style={{ margin: '4px 0 0' }}>Modifiers</h3>
      <p className="muted field-hint" style={{ marginTop: 0 }}>
        A required, choose-one group is a size. The price next to each option is the item&apos;s <strong>final price</strong> at that
        size — no adding to the base in your head.
      </p>
      <ErrorBanner error={link.error ?? unlink.error ?? createGroup.error} />
      {basePriceDirty && <p className="muted field-hint">Save the base price first, then its sizes are priced against it.</p>}

      {allGroups.isLoading && <Loading />}
      {attachedGroups.length === 0 && <p className="muted">No modifiers on this item yet.</p>}

      {attachedGroups.map((group) => (
        <ItemGroupCard
          key={group.id}
          item={item}
          group={group}
          basePriceMinor={basePriceMinor}
          basePriceDirty={basePriceDirty}
          onRemove={() => unlink.mutate({ itemId: item.id, groupId: group.id })}
        />
      ))}

      {reusableGroups.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="muted field-hint" style={{ margin: 0 }}>
            Reuse a group:
          </span>
          {reusableGroups.map((group) => (
            <button key={group.id} className="ghost" disabled={link.isPending} onClick={() => link.mutate({ itemId: item.id, groupId: group.id })}>
              + {group.name}
            </button>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          placeholder="New group name (e.g. Size)"
          value={newGroupName}
          onChange={(event) => setNewGroupName(event.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <label className="checkbox-row" style={{ margin: 0 }}>
          <input type="checkbox" checked={newGroupRequired} onChange={(event) => setNewGroupRequired(event.target.checked)} /> required, choose one
        </label>
        <button disabled={!newGroupName.trim() || createGroup.isPending || link.isPending} onClick={() => void addGroup()}>
          + Add modifier group
        </button>
      </div>
    </div>
  );
}

/**
 * One attached group inside the item editor: its options and, for each,
 * the price on THIS item.
 *
 * For a size (required, choose-one) the field is the item's final price
 * at that size — Half Rs 1,100, Full Rs 2,100 — and the delta the
 * database actually stores (final − base) is computed here so the
 * manager never sees or types one. For an optional add-on group the
 * field is what the option adds, because that is what "extra cheese
 * +Rs 100" honestly is.
 */
function ItemGroupCard({
  item,
  group,
  basePriceMinor,
  basePriceDirty,
  onRemove,
}: {
  item: MenuItem;
  group: ModifierGroup;
  basePriceMinor: Paisa;
  basePriceDirty: boolean;
  onRemove: () => void;
}): JSX.Element {
  const modifiers = useModifiers(group.id);
  const overrides = useItemModifierPrices(item.id);
  const setPrice = useSetItemModifierPrice();
  const clearPrice = useClearItemModifierPrice();
  const createModifier = useCreateModifier();

  // A variant (size) group prices in final selling prices; an add-on
  // group prices in the amount it adds. This is the group's own recorded
  // intent (migration 0021), NOT a guess from its select counts — the
  // guess is exactly what charged a Rs 200 size Rs 400.
  const isSize = group.pricingMode === 'variant';
  const [edits, setEdits] = useState<Record<number, Paisa>>({});
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState<Paisa>(isSize ? basePriceMinor : paisa(0));

  const overrideFor = (modifierId: number) => overrides.data?.find((row) => row.modifierId === modifierId)?.priceDeltaMinor;
  const effectiveDelta = (modifier: Modifier) => overrideFor(modifier.id) ?? modifier.priceDeltaMinor;
  // What the field shows: for a size, the final price (base + delta);
  // for an add-on, the amount it adds.
  const fieldOf = (modifier: Modifier): Paisa => (isSize ? add(basePriceMinor, effectiveDelta(modifier)) : effectiveDelta(modifier));
  // What the field is turned back into for storage: a size's final price
  // becomes a delta against the base; an add-on already is one.
  const toDelta = (fieldValue: Paisa): Paisa => (isSize ? sub(fieldValue, basePriceMinor) : fieldValue);
  // A size can never be priced below the item's base price. The base
  // price is the cheapest size, so the base option sits exactly at it and
  // every other size is above it; a size below would be a negative delta,
  // which the line-allocation pipeline cannot represent (it prorates a
  // discount across non-negative parts). Caught here with a clear message
  // rather than as a cryptic failure when a cashier tries to sell it.
  const belowBase = (fieldValue: Paisa): boolean => isSize && fieldValue < basePriceMinor;

  const dropEdit = (modifierId: number) =>
    setEdits((all) => Object.fromEntries(Object.entries(all).filter(([key]) => Number(key) !== modifierId)));

  const addOption = async () => {
    if (belowBase(newPrice)) return;
    // The option's price is a per-item override, so the group's own
    // default stays zero — the same shape the menu import writes.
    const created = await createModifier.mutateAsync({ groupId: group.id, name: newName.trim(), priceDeltaMinor: paisa(0) });
    const delta = toDelta(newPrice);
    if (delta !== 0) await setPrice.mutateAsync({ itemId: item.id, modifierId: created.id, priceDeltaMinor: delta });
    setNewName('');
    setNewPrice(isSize ? basePriceMinor : paisa(0));
  };

  return (
    <div className="card col option-group">
      <div className="row">
        <div style={{ flex: 1 }}>
          <strong>{group.name}</strong>{' '}
          <span className="muted">{isSize ? 'required — choose one (a size)' : `choose ${group.minSelect}–${group.maxSelect} (add-ons)`}</span>
        </div>
        <button className="ghost" onClick={onRemove}>
          Remove from item
        </button>
      </div>

      <div className="col option-prices">
        <ErrorBanner error={setPrice.error ?? clearPrice.error ?? createModifier.error} />
        {modifiers.data?.map((modifier) => {
          const field = edits[modifier.id] ?? fieldOf(modifier);
          const unchanged = field === fieldOf(modifier);
          const hasOverride = overrideFor(modifier.id) !== undefined;
          const invalid = belowBase(field);
          return (
            <div key={modifier.id} className="col">
              <div className="row option-price-row">
                <span style={{ flex: 1 }}>{modifier.name}</span>
                {!isSize && <span className="muted">+</span>}
                <MoneyInput valueMinor={field} onChange={(next) => setEdits((all) => ({ ...all, [modifier.id]: next }))} />
                <button
                  disabled={basePriceDirty || setPrice.isPending || unchanged || invalid}
                  onClick={() =>
                    setPrice.mutate({ itemId: item.id, modifierId: modifier.id, priceDeltaMinor: toDelta(field) }, { onSuccess: () => dropEdit(modifier.id) })
                  }
                >
                  Save
                </button>
                {hasOverride && (
                  <button
                    className="ghost"
                    disabled={clearPrice.isPending}
                    onClick={() => clearPrice.mutate({ itemId: item.id, modifierId: modifier.id }, { onSuccess: () => dropEdit(modifier.id) })}
                  >
                    Reset
                  </button>
                )}
              </div>
              {invalid && (
                <p className="muted field-hint" style={{ marginTop: 0 }}>
                  A size can’t be cheaper than the item’s base price (<Money minor={basePriceMinor} />). Set the base price to the
                  cheapest size first.
                </p>
              )}
            </div>
          );
        })}
        {modifiers.data?.length === 0 && <p className="muted field-hint">No options yet — add the first one below.</p>}

        <div className="col">
          <div className="row option-price-row">
            <input
              className="option-name-input"
              placeholder={isSize ? 'New size (e.g. Full)' : 'New add-on'}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            {!isSize && <span className="muted">+</span>}
            <MoneyInput valueMinor={newPrice} onChange={setNewPrice} />
            <button
              disabled={!newName.trim() || basePriceDirty || belowBase(newPrice) || createModifier.isPending || setPrice.isPending}
              onClick={() => void addOption()}
            >
              + Add
            </button>
          </div>
          {belowBase(newPrice) && (
            <p className="muted field-hint" style={{ marginTop: 0 }}>
              A size can’t be cheaper than the item’s base price (<Money minor={basePriceMinor} />).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Creating the groups themselves — sizes, spice levels, add-ons. */
function ModifierGroupsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const groups = useModifierGroups();
  const createGroup = useCreateModifierGroup();
  const createModifier = useCreateModifier();

  const [name, setName] = useState('');
  const [mode, setMode] = useState<ModifierPricingMode>('variant');
  const [optionFor, setOptionFor] = useState<number | ''>('');
  const [optionName, setOptionName] = useState('');

  return (
    <Modal title="Modifier groups" wide onClose={onClose}>
      <div className="col">
        <ErrorBanner error={createGroup.error ?? createModifier.error} />
        <p className="muted field-hint" style={{ marginTop: 0 }}>
          Reusable choices you attach to items — Size (Half / Full), Spice level, and so on. Set the <strong>prices</strong> on each
          item, under Edit → Modifiers, because the same size costs a different amount on different dishes.
        </p>

        <div className="card col">
          <h3 style={{ margin: 0 }}>New group</h3>
          <div>
            <label htmlFor="group-name">Group name</label>
            <input id="group-name" placeholder="Half / Full" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <fieldset className="col" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="muted" style={{ padding: 0 }}>
              How is it priced?
            </legend>
            <label className="checkbox-row">
              <input type="radio" name="pricing-mode" checked={mode === 'variant'} onChange={() => setMode('variant')} />
              <span>
                A <strong>size / variant</strong> — the customer picks one, and the price you enter for each option is the{' '}
                <strong>final price</strong> of the item at that size (Full = Rs 2,000, not +Rs 2,000).
              </span>
            </label>
            <label className="checkbox-row">
              <input type="radio" name="pricing-mode" checked={mode === 'add_on'} onChange={() => setMode('add_on')} />
              <span>
                An <strong>add-on</strong> — the customer may pick any number, and the price you enter is{' '}
                <strong>added on top</strong> (Extra cheese = +Rs 100).
              </span>
            </label>
          </fieldset>
          <button
            className="primary"
            disabled={!name.trim() || createGroup.isPending}
            onClick={() =>
              createGroup.mutate(
                // A size is choose-exactly-one; an add-on is choose-any.
                mode === 'variant'
                  ? { name: name.trim(), minSelect: 1, maxSelect: 1, pricingMode: 'variant' }
                  : { name: name.trim(), minSelect: 0, maxSelect: 5, pricingMode: 'add_on' },
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
            <p className="muted field-hint">Just the name here. Its price is set per item, under Edit → Modifiers.</p>
          </div>
          <button
            className="primary"
            disabled={!optionName.trim() || optionFor === '' || createModifier.isPending}
            onClick={() =>
              createModifier.mutate(
                { groupId: Number(optionFor), name: optionName.trim(), priceDeltaMinor: paisa(0) },
                { onSuccess: () => setOptionName('') },
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
  const updateGroup = useUpdateModifierGroup();

  // Switching mode also sets the select range that mode implies, so a
  // size that was mistakenly an add-on becomes choose-exactly-one in one
  // step. The option prices then need re-entering as final prices under
  // Edit → Modifiers, which is expected: the old numbers meant something
  // different.
  const setMode = (pricingMode: ModifierPricingMode) => {
    if (pricingMode === group.pricingMode) return;
    updateGroup.mutate(
      pricingMode === 'variant'
        ? { id: group.id, pricingMode: 'variant', minSelect: 1, maxSelect: 1 }
        : { id: group.id, pricingMode: 'add_on', minSelect: 0, maxSelect: 5 },
    );
  };

  return (
    <tr>
      <td>
        <strong>{group.name}</strong>
      </td>
      <td>
        <select
          value={group.pricingMode}
          disabled={updateGroup.isPending}
          onChange={(event) => setMode(event.target.value as ModifierPricingMode)}
          aria-label={`How ${group.name} is priced`}
        >
          <option value="variant">Size — final price</option>
          <option value="add_on">Add-on — extra charge</option>
        </select>
        <div className="muted field-hint">
          {group.minSelect === 1 && group.maxSelect === 1 ? 'choose one' : `choose ${group.minSelect}–${group.maxSelect}`}
        </div>
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
