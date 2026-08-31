import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.tsx';
import { BillScreen } from './screens/BillScreen.tsx';
import { FloorScreen } from './screens/FloorScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { MenuConfigScreen } from './screens/MenuConfigScreen.tsx';
import { OrderScreen } from './screens/OrderScreen.tsx';
import { PartnerConfigScreen } from './screens/PartnerConfigScreen.tsx';
import { PaymentMethodConfigScreen } from './screens/PaymentMethodConfigScreen.tsx';
import { PaymentScreen } from './screens/PaymentScreen.tsx';
import { PeopleConfigScreen } from './screens/PeopleConfigScreen.tsx';
import { ReportsScreen } from './screens/ReportsScreen.tsx';
import { ShiftScreen } from './screens/ShiftScreen.tsx';
import { StaffMealScreen } from './screens/StaffMealScreen.tsx';

/** Config and reporting screens are manager+; the order-taking screens
 * are open to any signed-in user, matching how the API itself gates
 * them (the server is the real authority — this only avoids showing a
 * cashier a screen whose every call would 403). */
function ManagerOnly({ children }: { children: JSX.Element }): JSX.Element {
  const { hasAtLeastRole } = useAuth();
  return hasAtLeastRole('manager') ? children : <Navigate to="/" replace />;
}

export function App(): JSX.Element {
  const { session, logout } = useAuth();

  if (!session) return <LoginScreen />;

  return (
    <div className="app">
      <header className="topbar">
        <strong>POS</strong>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Floor
          </NavLink>
          <NavLink to="/staff-meal" className={({ isActive }) => (isActive ? 'active' : '')}>
            Staff meal
          </NavLink>
          <NavLink to="/shift" className={({ isActive }) => (isActive ? 'active' : '')}>
            Shift
          </NavLink>
          <NavLink to="/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
            Reports
          </NavLink>
          <NavLink to="/config/menu" className={({ isActive }) => (isActive ? 'active' : '')}>
            Menu
          </NavLink>
          <NavLink to="/config/partners" className={({ isActive }) => (isActive ? 'active' : '')}>
            Partners
          </NavLink>
          <NavLink to="/config/payment-methods" className={({ isActive }) => (isActive ? 'active' : '')}>
            Payment
          </NavLink>
          <NavLink to="/config/people" className={({ isActive }) => (isActive ? 'active' : '')}>
            People
          </NavLink>
        </nav>
        <span className="spacer" />
        <span className="muted">
          {session.name} · {session.role} · {session.terminalId}
        </span>
        <button className="ghost" onClick={logout}>
          Sign out
        </button>
      </header>

      <main className="screen">
        <Routes>
          <Route path="/" element={<FloorScreen />} />
          <Route path="/orders/:orderId" element={<OrderScreen />} />
          <Route path="/orders/:orderId/bill" element={<BillScreen />} />
          <Route path="/orders/:orderId/payment" element={<PaymentScreen />} />
          <Route path="/staff-meal" element={<StaffMealScreen />} />
          <Route path="/shift" element={<ShiftScreen />} />
          <Route
            path="/reports"
            element={
              <ManagerOnly>
                <ReportsScreen />
              </ManagerOnly>
            }
          />
          <Route
            path="/config/menu"
            element={
              <ManagerOnly>
                <MenuConfigScreen />
              </ManagerOnly>
            }
          />
          <Route
            path="/config/partners"
            element={
              <ManagerOnly>
                <PartnerConfigScreen />
              </ManagerOnly>
            }
          />
          <Route
            path="/config/payment-methods"
            element={
              <ManagerOnly>
                <PaymentMethodConfigScreen />
              </ManagerOnly>
            }
          />
          <Route
            path="/config/people"
            element={
              <ManagerOnly>
                <PeopleConfigScreen />
              </ManagerOnly>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
