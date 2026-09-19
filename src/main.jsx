import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './lib/AuthContext.jsx';
import { TenantProvider } from './lib/TenantContext.jsx';
import { ToastProvider } from './lib/ToastContext.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import App from './App.jsx';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// TenantProvider sits inside AuthProvider because it cannot resolve a
// membership without a user, and outside everything else because almost every
// query in the app is scoped by the tenant it picks.
//
// basename: the bundle is served at /app.html while the legacy marketplace
// still owns /. Routes are written as /dashboard/... and resolve from the
// root, which works because app.html is served for those paths too once the
// Worker has an SPA fallback — until then, open /app.html directly in dev.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TenantProvider>
          <ToastProvider>
            <BrowserRouter>
              <ErrorBoundary>
                <App />
              </ErrorBoundary>
            </BrowserRouter>
          </ToastProvider>
        </TenantProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
