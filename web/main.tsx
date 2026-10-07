import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { startPush } from './push.ts';
import './theme.css';

// The fixtures live in their own chunk, fetched only when the page asks for them. Awaited
// so the fake Hub is in place before `App` or `startPush` makes the first `/api` call.
if (new URLSearchParams(location.search).has('mock') || import.meta.env.VITE_MOCK === '1') {
  const { installMock } = await import('./mock.ts');
  installMock();
}

// Registers `/sw.js` in a build, or in dev with `?sw`. Everything else about push waits
// for the Settings toggle.
startPush();

// Agentation: dev-only annotation overlay that hands UI notes to Claude Code over MCP
// (see .mcp.json). Desktop pointers only; it is not built for touch and never ships.
const Dev =
  import.meta.env.DEV && matchMedia('(pointer: fine)').matches
    ? lazy(() => import('agentation').then((m) => ({ default: m.Agentation })))
    : null;

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    {Dev && (
      <Suspense>
        <Dev />
      </Suspense>
    )}
  </>,
);
