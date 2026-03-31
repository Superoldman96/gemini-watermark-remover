import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('package.json should expose cleanup scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.scripts.clean, 'node scripts/clean.js');
  assert.equal(pkg.scripts['clean:all'], 'node scripts/clean.js --include-profile');
});

test('clean script should default to generated artifacts and keep the fixed Chrome profile optional', async () => {
  const scriptUrl = new URL('../../scripts/clean.js', import.meta.url);
  assert.equal(existsSync(scriptUrl), true, 'expected scripts/clean.js to exist');
  if (!existsSync(scriptUrl)) {
    return;
  }

  const {
    DEFAULT_CLEAN_PATHS,
    OPTIONAL_CLEAN_PATHS,
    resolveCleanupTargets
  } = await import(scriptUrl.href);

  assert.deepEqual(DEFAULT_CLEAN_PATHS, [
    'dist',
    '.artifacts',
    'src/assets/samples/fix'
  ]);
  assert.deepEqual(OPTIONAL_CLEAN_PATHS, ['.chrome-debug']);
  assert.deepEqual(resolveCleanupTargets(), [
    'dist',
    '.artifacts',
    'src/assets/samples/fix'
  ]);
  assert.deepEqual(resolveCleanupTargets({ includeProfile: true }), [
    'dist',
    '.artifacts',
    'src/assets/samples/fix',
    '.chrome-debug'
  ]);
});
