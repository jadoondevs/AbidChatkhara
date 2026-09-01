import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import './index.css';
import { registerServiceWorker } from './pwa.ts';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A till is a live board of what other terminals are doing, and
      // this system has no push channel by design (one server, one LAN).
      // Refetching on focus and never trusting a cached list for long is
      // what keeps two tills honest about each other.
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

registerServiceWorker();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
