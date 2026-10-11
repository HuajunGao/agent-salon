// For the tests that run a real server: copies the app into dir/app, every module but agents.mjs (each test writes a
// fake one that records the turns), so a new module needs no change here.
import { readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export function copyApp(root) {
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  for (const f of readdirSync(HERE))
    if ((f.endsWith('.mjs') && f !== 'agents.mjs' && !f.endsWith('.test.mjs')) || f === 'index.html' || f === 'ui.js')
      copyFileSync(join(HERE, f), join(app, f));
  return app;
}
