// Runs the Playwright Electron specs that do not need the Qt compatibility
// harness. 16 of the 42 specs drive `.cache/qt-compat/qt-compat.exe` (built by
// scripts/build-qt-compat.ps1 from Qt 6.8.3 plus the sibling Qt project's
// libtlcore.a) and therefore only run on a prepared machine, see
// .github/workflows/e2e-selfhosted.yml. The remaining specs run in CI.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dir = path.join('tests', 'e2e');
const specs = readdirSync(dir).filter(file => file.endsWith('.spec.ts')).sort();
const needsQt = file => readFileSync(path.join(dir, file), 'utf8').includes('qt-compat');
const runnable = specs.filter(file => !needsQt(file));
const skipped = specs.filter(needsQt);

console.log(`e2e-ci: ${runnable.length} specs run, ${skipped.length} skipped (need .cache/qt-compat/qt-compat.exe)`);
if (skipped.length) console.log(`e2e-ci: skipped -> ${skipped.join(', ')}`);
if (!runnable.length) throw new Error('No runnable Playwright specs found.');

// The CLI treats each argument as a regex matched against the test file path and
// normalizes separators to "/", so pass forward-slash relative paths: a Windows
// absolute path (D:\a\...) matches nothing and aborts with "No tests found.".
const filter = file => `${dir}/${file}`;
const result = spawnSync(
  process.execPath,
  [require.resolve('@playwright/test/cli'), 'test', ...runnable.map(filter)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
