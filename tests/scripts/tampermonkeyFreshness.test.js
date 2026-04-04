import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_TAMPERMONKEY_FRESHNESS_CDP_URL,
  DEFAULT_TAMPERMONKEY_FRESHNESS_SCRIPT_PATH,
  chooseBestEditorSourceCandidate,
  computeUserscriptFreshness,
  parseTampermonkeyFreshnessCliArgs,
  shouldFailTampermonkeyFreshnessCheck
} from '../../scripts/tampermonkey-freshness.js';

test('parseTampermonkeyFreshnessCliArgs should default to the fixed CDP endpoint and local dist userscript', () => {
  const parsed = parseTampermonkeyFreshnessCliArgs([]);

  assert.equal(parsed.cdpUrl, DEFAULT_TAMPERMONKEY_FRESHNESS_CDP_URL);
  assert.equal(parsed.scriptPath, DEFAULT_TAMPERMONKEY_FRESHNESS_SCRIPT_PATH);
});

test('parseTampermonkeyFreshnessCliArgs should accept explicit cdp url and script path overrides', () => {
  const parsed = parseTampermonkeyFreshnessCliArgs([
    '--cdp',
    'http://127.0.0.1:9333',
    '--script',
    'tmp/custom.user.js'
  ]);

  assert.equal(parsed.cdpUrl, 'http://127.0.0.1:9333');
  assert.match(parsed.scriptPath, /tmp\/custom\.user\.js$/);
});

test('chooseBestEditorSourceCandidate should prefer the longest non-empty CodeMirror value', () => {
  const candidate = chooseBestEditorSourceCandidate([
    {
      index: 0,
      value: '// ==UserScript==\n// @name New Userscript\n',
      valueLength: 40
    },
    {
      index: 1,
      value: '// ==UserScript==\n// @name Gemini NanoBanana Watermark Remover\nconst sticky = "DEFAULT_DOWNLOAD_STICKY_WINDOW_MS";\n',
      valueLength: 116
    }
  ]);

  assert.deepEqual(candidate, {
    index: 1,
    value: '// ==UserScript==\n// @name Gemini NanoBanana Watermark Remover\nconst sticky = "DEFAULT_DOWNLOAD_STICKY_WINDOW_MS";\n',
    valueLength: 116
  });
});

test('computeUserscriptFreshness should report fresh when installed and local userscript bodies match exactly', () => {
  const source = '// ==UserScript==\nconst sticky = "DEFAULT_DOWNLOAD_STICKY_WINDOW_MS";\n';
  const result = computeUserscriptFreshness({
    installedSource: source,
    localSource: source,
    requiredMarkers: ['DEFAULT_DOWNLOAD_STICKY_WINDOW_MS']
  });

  assert.equal(result.status, 'fresh');
  assert.equal(result.exactMatch, true);
  assert.deepEqual(result.installedMissingMarkers, []);
  assert.deepEqual(result.localMissingMarkers, []);
});

test('computeUserscriptFreshness should report stale when installed source misses required markers from the local build', () => {
  const result = computeUserscriptFreshness({
    installedSource: '// ==UserScript==\nconst oldCode = true;\n',
    localSource: '// ==UserScript==\nconst sticky = "DEFAULT_DOWNLOAD_STICKY_WINDOW_MS";\n',
    requiredMarkers: ['DEFAULT_DOWNLOAD_STICKY_WINDOW_MS']
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.exactMatch, false);
  assert.deepEqual(result.installedMissingMarkers, ['DEFAULT_DOWNLOAD_STICKY_WINDOW_MS']);
  assert.deepEqual(result.localMissingMarkers, []);
});

test('shouldFailTampermonkeyFreshnessCheck should fail closed for stale results only', () => {
  assert.equal(shouldFailTampermonkeyFreshnessCheck({ status: 'fresh' }), false);
  assert.equal(shouldFailTampermonkeyFreshnessCheck({ status: 'stale' }), true);
});

test('package.json should expose a tampermonkey freshness command', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.scripts['probe:tm:freshness'], 'node scripts/tampermonkey-freshness.js');
});
