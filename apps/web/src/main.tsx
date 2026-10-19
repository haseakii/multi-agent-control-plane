import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main className="page-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">LOCAL-FIRST · ACP-READY</p>
        <h1 id="page-title">Multi-Agent Control Plane</h1>
        <p className="intro">
          A vendor-neutral control center for registering agents, assigning work, and observing
          collaboration.
        </p>
        <div className="status" role="status">
          <span className="status-dot" aria-hidden="true" />
          V0 bootstrap is running
        </div>
        <p className="note">
          The control-plane UI is ready for the next implementation phase. Agent registry and task
          orchestration will be added incrementally.
        </p>
      </section>
    </main>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
