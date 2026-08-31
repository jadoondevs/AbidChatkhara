import { useState } from 'react';
import { useCreatePerson, usePeople, useUpdatePerson } from '../api/hooks.js';
import type { MealPolicy, PersonKind } from '../api/types.js';
import { ErrorBanner, Loading } from '../components/ui.tsx';

const POLICIES: MealPolicy[] = ['free', 'discounted', 'full_price', 'payroll_deduction'];

/** Screen 10: staff and partners, with a meal policy per person. The
 * policy in force at settlement is snapshotted onto that meal's own
 * record, so changing it here never rewrites what someone was already
 * charged (docs/decisions/009). */
export function PeopleConfigScreen(): JSX.Element {
  const people = usePeople(undefined, true);
  const createPerson = useCreatePerson();
  const updatePerson = useUpdatePerson();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<PersonKind>('staff');
  const [mealPolicy, setMealPolicy] = useState<MealPolicy>('free');
  const [discountPercent, setDiscountPercent] = useState('50');

  const submit = () => {
    createPerson.mutate(
      {
        name: name.trim(),
        kind,
        mealPolicy,
        ...(mealPolicy === 'discounted' ? { mealDiscountBp: Math.round(Number(discountPercent) * 100) } : {}),
      },
      { onSuccess: () => setName('') },
    );
  };

  return (
    <div className="col" style={{ maxWidth: 1000 }}>
      <h1 style={{ margin: 0 }}>People</h1>
      <ErrorBanner error={createPerson.error ?? updatePerson.error} />

      <div className="card">
        {people.isLoading && <Loading />}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Meal policy</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {people.data?.map((person) => (
              <tr key={person.id}>
                <td>{person.name}</td>
                <td className="muted">{person.kind}</td>
                <td>
                  <select
                    value={person.mealPolicy}
                    onChange={(event) => {
                      const nextPolicy = event.target.value as MealPolicy;
                      updatePerson.mutate({
                        id: person.id,
                        mealPolicy: nextPolicy,
                        // A discounted policy needs a positive discount;
                        // keep the existing one, or start at 50%.
                        ...(nextPolicy === 'discounted' && person.mealDiscountBp <= 0 ? { mealDiscountBp: 5_000 } : {}),
                      });
                    }}
                  >
                    {POLICIES.map((policy) => (
                      <option key={policy} value={policy}>
                        {policy.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                  {person.mealPolicy === 'discounted' && <span className="muted"> {person.mealDiscountBp / 100}% off</span>}
                </td>
                <td>
                  <button onClick={() => updatePerson.mutate({ id: person.id, active: !person.active })}>
                    {person.active ? 'Active' : 'Inactive'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card col" style={{ maxWidth: 620 }}>
        <h3 style={{ margin: 0 }}>Add a person</h3>
        <div>
          <label htmlFor="person-name">Name</label>
          <input id="person-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>

        <div>
          <label>Kind</label>
          <div className="tabs">
            {(['staff', 'partner'] as const).map((option) => (
              <button key={option} className={option === kind ? 'active' : ''} onClick={() => setKind(option)}>
                {option === 'staff' ? 'Staff' : 'Partner (owner)'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label>Meal policy</label>
          <div className="tabs">
            {POLICIES.map((policy) => (
              <button key={policy} className={policy === mealPolicy ? 'active' : ''} onClick={() => setMealPolicy(policy)}>
                {policy.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        {mealPolicy === 'discounted' && (
          <div style={{ maxWidth: 200 }}>
            <label htmlFor="discount-percent">Discount %</label>
            <input id="discount-percent" inputMode="decimal" value={discountPercent} onChange={(event) => setDiscountPercent(event.target.value)} />
          </div>
        )}

        <button className="primary" disabled={!name.trim() || createPerson.isPending} onClick={submit}>
          Add person
        </button>
      </div>
    </div>
  );
}
