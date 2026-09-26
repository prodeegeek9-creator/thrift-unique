import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import RequireAuth from './components/RequireAuth.jsx';
import RequireFeature from './components/RequireFeature.jsx';
import RequireStaffRole from './components/RequireStaffRole.jsx';
import RequireOperator from './components/RequireOperator.jsx';
import SellerShell from './components/layout/SellerShell.jsx';

import Login from './pages/Login.jsx';
import Onboarding from './pages/Onboarding.jsx';
import ConnectChannels from './pages/ConnectChannels.jsx';
import NotFound from './pages/NotFound.jsx';
import Product from './pages/public/Product.jsx';
import Store from './pages/public/Store.jsx';
import Home from './pages/public/Home.jsx';
import PayLink from './pages/public/PayLink.jsx';
import OrderStatus from './pages/public/OrderStatus.jsx';
import PlanPay from './pages/public/PlanPay.jsx';
import ConfirmReceipt from './pages/public/ConfirmReceipt.jsx';

import Overview from './pages/seller/Overview.jsx';
import Listings from './pages/seller/Listings.jsx';
import Submissions from './pages/seller/Submissions.jsx';
import Orders from './pages/seller/Orders.jsx';
import OrderDetail from './pages/seller/OrderDetail.jsx';
import Payouts from './pages/seller/Payouts.jsx';
import Contacts from './pages/seller/Contacts.jsx';
import Disputes from './pages/seller/Disputes.jsx';
import Team from './pages/seller/Team.jsx';
import Channels from './pages/seller/Channels.jsx';
import Billing from './pages/seller/Billing.jsx';
import Settings from './pages/seller/Settings.jsx';
import Help from './pages/seller/Help.jsx';
import More from './pages/seller/More.jsx';

// Lazy: it is the only screen that pulls in Recharts, and that library is
// roughly half the bundle. It is also Business-tier, so RequireFeature renders
// the upsell instead — a Starter seller who opens /dashboard/analytics never
// downloads the chunk at all.
const Analytics = lazy(() => import('./pages/seller/Analytics.jsx'));

// Same reasoning, stronger: the platform console is six screens that exactly
// one person on the platform can open. RequireOperator resolves before this
// does, so a seller who types /admin never downloads the chunk at all.
const AdminRoutes = lazy(() => import('./pages/admin/AdminRoutes.jsx'));

// Note the shape of the guarded routes: RequireFeature wraps the *element*,
// not the route, so the path still resolves and the URL stays put. A Starter
// seller who clicks Contacts lands on /dashboard/contacts and reads why it is
// worth having, rather than being bounced to the overview with no explanation.
// See RequireFeature.jsx.
export default function App() {
  return (
    <Routes>
      {/* The public documents: one item, one store's own page, and the
          receipt confirmation. No marketplace — each store's page shows that
          store alone. See pages/public/Product.jsx and Store.jsx. */}
      <Route path="/p/:code" element={<Product />} />
      <Route path="/s/:slug" element={<Store />} />
      <Route path="/pay/:token" element={<PayLink />} />
      <Route path="/order/:reference" element={<OrderStatus />} />
      <Route path="/billing/pay/:ref" element={<PlanPay />} />
      <Route path="/confirm/:token" element={<ConfirmReceipt />} />

      <Route path="/login" element={<Login />} />
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="/connect" element={<ConnectChannels />} />

      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <SellerShell />
          </RequireAuth>
        }
      >
        <Route index element={<Overview />} />
        <Route path="listings" element={<Listings />} />
        <Route path="submissions" element={<Submissions />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:orderId" element={<OrderDetail />} />
        <Route path="payouts" element={<Payouts />} />

        <Route
          path="contacts"
          element={
            <RequireFeature flag="contacts">
              <Contacts />
            </RequireFeature>
          }
        />
        <Route
          path="disputes"
          element={
            <RequireFeature flag="disputes">
              <Disputes />
            </RequireFeature>
          }
        />
        <Route
          path="analytics"
          element={
            <RequireFeature flag="analytics">
              <Suspense fallback={<div className="h-96 animate-pulse rounded-card bg-surface-2" />}>
                <Analytics />
              </Suspense>
            </RequireFeature>
          }
        />
        {/* Two gates, and they refuse for different reasons: the tenant's plan
            has to carry multi-staff at all, and then only an owner gets to
            change who can sign in. No plan fixes the second one. */}
        <Route
          path="team"
          element={
            <RequireFeature flag="team">
              <RequireStaffRole min="owner">
                <Team />
              </RequireStaffRole>
            </RequireFeature>
          }
        />

        <Route path="channels" element={<Channels />} />
        <Route path="billing" element={<Billing />} />
        <Route path="settings" element={<Settings />} />
        <Route path="help" element={<Help />} />
        <Route path="more" element={<More />} />
      </Route>

      {/* The platform side. Every route under here reads across tenants,
          which nothing else in the system may do — the actual boundary is in
          the Worker, and this only avoids drawing a console to somebody whose
          every request would 403. */}
      <Route
        path="/admin/*"
        element={
          <RequireOperator>
            <Suspense fallback={<div className="min-h-dvh bg-bg" />}>
              <AdminRoutes />
            </Suspense>
          </RequireOperator>
        }
      />

      <Route path="/" element={<Home />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
