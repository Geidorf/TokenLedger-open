import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './styles/shell.css';
import './styles/surfaces.css';
import './styles/settings-pages.css';
import './styles/onboarding.css';
import { initializeTheme } from './utils/useTheme';

async function bootstrap() {
  // Apply the shared theme before the optional development mock is loaded so
  // the shell never paints with a transient, mismatched palette.
  initializeTheme();
  if (import.meta.env.DEV && typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
    const { installDevMockTauri } = await import('./devMockTauri');
    installDevMockTauri();
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();
