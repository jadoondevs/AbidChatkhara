import { paisa, type Paisa } from '@pos/shared';
import { useState } from 'react';
import { useCategories, useCreateCategory, useCreateItem, useMenu, useSetItemAvailability, useSetItemPrice } from '../api/hooks.js';
import { ErrorBanner, Loading, Money, MoneyInput } from '../components/ui.tsx';

/**
 * Screen 7: categories, items, prices and the availability toggle. A
 * price change writes a NEW effective-dated price row rather than
 * editing the old one (the server does that) — past orders keep the
 * price they were rung up at.
 */
export function MenuConfigScreen(): JSX.Element {
  const categories = useCategories(true);
  const menu = useMenu();
  const createCategory = useCreateCategory();
  const createItem = useCreateItem();
  const setPrice = useSetItemPrice();
  const setAvailability = useSetItemAvailability();

  const [categoryName, setCategoryName] = useState('');
  const [itemName, setItemName] = useState('');
  const [itemCategoryId, setItemCategoryId] = useState<number | ''>('');
  const [priceEdits, setPriceEdits] = useState<Record<number, Paisa>>({});

  return (
    <div className="col" style={{ maxWidth: 1100 }}>
      <div>
        <p className="page-kicker">Catalog</p>
        <h1 style={{ margin: 0 }}>Menu</h1>
      </div>
      <ErrorBanner error={createCategory.error ?? createItem.error ?? setPrice.error ?? setAvailability.error} />

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
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th className="num">Current price</th>
              <th style={{ width: 240 }}>New price</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            {menu.data?.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td className="muted">{categories.data?.find((category) => category.id === item.categoryId)?.name ?? item.categoryId}</td>
                <td className="num">{item.priceMinor === null ? <span className="muted">not set</span> : <Money minor={item.priceMinor} />}</td>
                <td>
                  <div className="row">
                    <MoneyInput
                      valueMinor={priceEdits[item.id] ?? paisa(0)}
                      onChange={(next) => setPriceEdits((current) => ({ ...current, [item.id]: next }))}
                    />
                    <button
                      disabled={!priceEdits[item.id] || setPrice.isPending}
                      onClick={() => setPrice.mutate({ itemId: item.id, priceMinor: priceEdits[item.id] ?? paisa(0) })}
                    >
                      Set
                    </button>
                  </div>
                </td>
                <td>
                  <button onClick={() => setAvailability.mutate({ itemId: item.id, available: !item.available })}>
                    {item.available ? 'Available' : 'Unavailable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
