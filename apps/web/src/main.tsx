import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './i18n';
import './fonts.css';
import './styles.css';
import { applyTheme, getThemeChoice } from './lib/theme';
import App from './App';

applyTheme(getThemeChoice());

// Excalidraw pulls its handwriting fonts from this base path; default is the
// esm.sh CDN which our CSP (font-src 'self' data:) correctly blocks. The web
// build copies the fonts into public/excalidraw-assets (scripts/copy-excalidraw-fonts.mjs).
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets';

// service-worker registration lives in the module bundle: an inline <script> in
// index.html would violate our own CSP (script-src 'self') on served builds.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
