import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { buildFixedOutputPath, writeFixedOutput } from '../../scripts/export-fixed-samples.js';

test('buildFixedOutputPath should place outputs under a sibling fix directory', () => {
    const output = buildFixedOutputPath('D:\\Project\\gemini-watermark-remover\\src\\assets\\samples\\16-9.png');
    assert.equal(output, 'D:\\Project\\gemini-watermark-remover\\src\\assets\\samples\\fix\\16-9.png');
});

test('buildFixedOutputPath should preserve extension case and nested dots', () => {
    const output = buildFixedOutputPath('D:\\tmp\\foo.bar.WEBP');
    assert.equal(output, 'D:\\tmp\\fix\\foo.bar.WEBP');
});

test('buildFixedOutputPath should preserve POSIX paths on non-Windows runners', () => {
    const output = buildFixedOutputPath('/tmp/foo.bar.webp');
    assert.equal(output, '/tmp/fix/foo.bar.webp');
});

test('buildFixedOutputPath should keep paths inside fix directory stable', () => {
    const output = buildFixedOutputPath('D:\\tmp\\fix\\foo.bar.WEBP');
    assert.equal(output, 'D:\\tmp\\fix\\foo.bar.WEBP');
});

test('writeFixedOutput should create the fix directory and overwrite existing files by default', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-export-'));
    const outputPath = path.join(tempDir, 'fix', 'sample.png');

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from('old'));
    await writeFixedOutput(outputPath, Buffer.from('new'));

    const saved = await readFile(outputPath, 'utf8');
    assert.equal(saved, 'new');
    await access(path.join(tempDir, 'fix'));
});
