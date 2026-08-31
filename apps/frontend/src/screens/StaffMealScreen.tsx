import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateOrder, usePeople } from '../api/hooks.js';
import type { Person, PersonKind } from '../api/types.js';
import { ErrorBanner, Loading } from '../components/ui.tsx';

/**
 * Screen 6: a visually distinct mode where the person is picked FIRST
 * (spec) — the order can't even be opened without one, because the
 * server refuses a staff_meal/owner_meal order with no beneficiary.
 * From here on the order screen shows a persistent banner with whose
 * meal it is and their policy.
 */
export function StaffMealScreen(): JSX.Element {
  const navigate = useNavigate();
  const [kind, setKind] = useState<PersonKind>('staff');
  const people = usePeople(kind);
  const createOrder = useCreateOrder();

  const start = (person: Person) => {
    createOrder.mutate(
      {
        orderType: 'takeaway',
        channel: person.kind === 'staff' ? 'staff_meal' : 'owner_meal',
        beneficiaryPersonId: person.id,
      },
      { onSuccess: (order) => navigate(`/orders/${order.id}`) },
    );
  };

  return (
    <div className="col" style={{ maxWidth: 900 }}>
      <div className="banner">Staff &amp; owner meals — pick the person first</div>
      <ErrorBanner error={createOrder.error ?? people.error} />

      <div className="tabs">
        <button className={kind === 'staff' ? 'active' : ''} onClick={() => setKind('staff')}>
          Staff
        </button>
        <button className={kind === 'partner' ? 'active' : ''} onClick={() => setKind('partner')}>
          Owners (partners)
        </button>
      </div>

      {people.isLoading && <Loading />}
      {people.data?.length === 0 && <p className="muted">Nobody set up yet — add people under People config.</p>}

      <div className="item-grid">
        {people.data?.map((person) => (
          <button key={person.id} disabled={createOrder.isPending} onClick={() => start(person)}>
            <strong>{person.name}</strong>
            <span className="muted">
              {person.mealPolicy.replace('_', ' ')}
              {person.mealPolicy === 'discounted' && ` · ${person.mealDiscountBp / 100}% off`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
