import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useSettings } from './api/hooks.js';
import { useAuth } from './auth/AuthContext.tsx';
import { NewOrderModal } from './components/NewOrderModal.tsx';
import { BillScreen } from './screens/BillScreen.tsx';
import { FloorScreen } from './screens/FloorScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { MenuConfigScreen } from './screens/MenuConfigScreen.tsx';
import { OrderDetailScreen } from './screens/OrderDetailScreen.tsx';
import { OrderScreen } from './screens/OrderScreen.tsx';
import { OrdersScreen } from './screens/OrdersScreen.tsx';
import { PartnerConfigScreen } from './screens/PartnerConfigScreen.tsx';
import { PaymentScreen } from './screens/PaymentScreen.tsx';
import { PeopleConfigScreen } from './screens/PeopleConfigScreen.tsx';
import { ReportsScreen } from './screens/ReportsScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { ShiftScreen } from './screens/ShiftScreen.tsx';
import { StaffMealScreen } from './screens/StaffMealScreen.tsx';

/**
 * Role gates for whole screens. The server is the real authority — every
 * call these screens make is checked there too — so this only avoids
 * showing someone a screen whose every request would come back 403.
 */
function RoleGate({ minimum, children }: { minimum: 'manager' | 'admin'; children: JSX.Element }): JSX.Element {
  const { hasAtLeastRole } = useAuth();
  return hasAtLeastRole(minimum) ? children : <Navigate to="/" replace />;
}

/**
 * Two letters for the header mark, taken from the restaurant's own
 * name: "Demo Karahi House" becomes DK, a one-word name gives its first
 * two letters. Derived rather than configured, because a mark nobody
 * maintains is a mark that goes stale the first time the name changes.
 */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0) return 'PO';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Operational screens everyone signed in can reach, then configuration
 * behind a role. Grouped so the nav reads as "run the restaurant" and
 * "set the restaurant up" rather than one undifferentiated row. */
const OPERATIONS = [
  // Floor is the live board; Orders is the history. Two screens because
  // they answer different questions — see OrdersScreen.
  { to: '/', label: 'Floor', end: true },
  { to: '/orders', label: 'Orders', end: false },
  // "Staff meal" rather than "Staff": this is where a meal is rung up
  // for a member of staff, not where staff records are kept. Those are
  // People (below) and Users (in Settings).
  { to: '/staff-meal', label: 'Staff meal', end: false },
  { to: '/shift', label: 'Shift', end: false },
] as const;

const MANAGEMENT = [
  { to: '/reports', label: 'Reports', minimum: 'manager' },
  { to: '/config/menu', label: 'Menu', minimum: 'manager' },
  { to: '/config/partners', label: 'Partners', minimum: 'manager' },
  { to: '/config/people', label: 'People', minimum: 'manager' },
  { to: '/settings', label: 'Settings', minimum: 'admin' },
] as const;

export function App(): JSX.Element {
  const { session, logout, hasAtLeastRole } = useAuth();
  const navigate = useNavigate();
  const settings = useSettings(session !== null);
  const [newOrderOpen, setNewOrderOpen] = useState(false);

  if (!session) return <LoginScreen />;

  // The restaurant's own name, never a compiled-in one. An install that
  // has configured nothing falls back to a neutral label rather than
  // claiming to be someone.
  const restaurantName = settings.data?.restaurant.name.trim() || 'POS';

  return (
    <div className="app">
      <header className="topbar">
        {/* The mark is the restaurant's own initials, derived from the
            name it configured — the header must never carry a brand
            this software invented for it. */}
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            {initialsOf(restaurantName)}
          </span>
          <span className="brand-text">
            <strong className="brand">{restaurantName}</strong>
            <span className="brand-sub">Restaurant POS</span>
          </span>
        </div>

        <nav>
          {OPERATIONS.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {link.label}
            </NavLink>
          ))}
          <span className="nav-divider" aria-hidden="true" />
          {MANAGEMENT.filter((link) => hasAtLeastRole(link.minimum)).map((link) => (
            <NavLink key={link.to} to={link.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <span className="spacer" />

        {/* New order is reachable from every screen, not just the floor:
            a customer arriving while a manager is reading a report is
            the normal case, not an exception. It heads the right-hand
            group, so it is in the same place on every screen and is the
            only filled accent in the header. */}
        <button className="primary new-order-button" onClick={() => setNewOrderOpen(true)}>
          + New order
        </button>

        {/* Name and role are what staff check; the terminal id matters
            only when reconciling an audit trail, so it lives in the
            tooltip rather than taking width from the nav. */}
        <span className="who" title={`Terminal ${session.terminalId}`}>
          <span className="who-name">{session.name}</span>
          <span className="who-role">
            {session.role} · Terminal {session.terminalId}
          </span>
        </span>
        <button className="ghost sign-out" onClick={logout}>
          Sign out
        </button>
      </header>

      <main className="screen">
        <Routes>
          <Route path="/" element={<FloorScreen />} />
          <Route path="/orders" element={<OrdersScreen />} />
          <Route path="/orders/:orderId" element={<OrderScreen />} />
          <Route path="/orders/:orderId/bill" element={<BillScreen />} />
          <Route path="/orders/:orderId/detail" element={<OrderDetailScreen />} />
          <Route path="/orders/:orderId/payment" element={<PaymentScreen />} />
          <Route path="/staff-meal" element={<StaffMealScreen />} />
          <Route path="/shift" element={<ShiftScreen />} />
          <Route
            path="/reports"
            element={
              <RoleGate minimum="manager">
                <ReportsScreen />
              </RoleGate>
            }
          />
          <Route
            path="/config/menu"
            element={
              <RoleGate minimum="manager">
                <MenuConfigScreen />
              </RoleGate>
            }
          />
          <Route
            path="/config/partners"
            element={
              <RoleGate minimum="manager">
                <PartnerConfigScreen />
              </RoleGate>
            }
          />
          {/* Payment configuration lives in one place now — Settings,
              beside the accounts the money lands in. The old path still
              resolves so a bookmark or a muscle-memory URL lands there
              rather than nowhere. */}
          <Route path="/config/payment-methods" element={<Navigate to="/settings" replace />} />
          <Route
            path="/config/people"
            element={
              <RoleGate minimum="manager">
                <PeopleConfigScreen />
              </RoleGate>
            }
          />
          <Route
            path="/settings"
            element={
              <RoleGate minimum="admin">
                <SettingsScreen />
              </RoleGate>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* One modal, one order-creation path, wherever it was opened from
          — the alternative is a second copy of this flow per screen. */}
      {newOrderOpen && (
        <NewOrderModal
          onClose={() => setNewOrderOpen(false)}
          onCreated={(orderId) => {
            setNewOrderOpen(false);
            navigate(`/orders/${orderId}`);
          }}
        />
      )}
    </div>
  );
}
