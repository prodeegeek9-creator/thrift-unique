import { Navigate, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/RequireAuth.jsx';
import RequireFeature from './components/RequireFeature.jsx';
import RequireStaffRole from './components/RequireStaffRole.jsx';
import SellerShell from './components/layout/SellerShell.jsx';

import Login from './pages/Login.jsx';
import Onboarding from './pages/Onboarding.jsx';
import ConnectChannels from './pages/ConnectChannels.jsx';
import NotFound from './pages/NotFound.jsx';
import Product from './pages/public/Product.jsx';
import ConfirmReceipt from './pages/public/ConfirmReceipt.jsx';

import Overview from './pages/seller/Overview.jsx';
import Listings from './pages/seller/Listings.jsx';
import Orders from './pages/seller/Orders.jsx';
import OrderDetail from './pages/seller/OrderDetail.jsx';
import Payouts from './pages/seller/Payouts.jsx';
import Contacts from './pages/seller/Contacts.jsx';
import Disputes from './pages/seller/Disputes.jsx';
import Analytics from './pages/seller/Analytics.jsx';
import Team from './pages/seller/Team.jsx';
import Channels from './pages/seller/Channels.jsx';
import Billing from './pages/seller/Billing.jsx';
import Settings from './pages/seller/Settings.jsx';
import Help from './pages/seller/Help.jsx';
import More from './pages/seller/More.jsx';

// Note the shape of the guarded routes: RequireFeature wraps the *element*,
// not the route, so the path still resolves and the URL stays put. A Starter
// seller who clicks Contacts lands on /dashboard/contacts and reads why it is
// worth having, rather than being bounced to the overview with no explanation.
// See RequireFeature.jsx.
export default function App() {
  return (
    <Routes>
      {/* The only two public documents. Not a storefront: one item at a time,
          reached by a link somebody was sent, with no cart and nothing to
          browse. See pages/public/Product.jsx. */}
      <Route path="/p/:code" element={<Product />} />
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
              <Analytics />
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

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
