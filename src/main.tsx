import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { EngineProvider } from './app/EngineContext';
import { graphController } from './graph/graphController';
import { registerStressGraphHelper } from './utils/stressGraph';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

// Development affordance only: loads a synthetic graph so rendering can be
// judged on a real canvas. `window.__lumieresStress(5000)` in the console.
if (import.meta.env.DEV) {
  registerStressGraphHelper(graphController);
}

createRoot(container).render(
  <StrictMode>
    <EngineProvider>
      <App />
    </EngineProvider>
  </StrictMode>,
);
