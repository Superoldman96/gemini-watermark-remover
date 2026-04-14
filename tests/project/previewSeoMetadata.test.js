import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readText(relativePath) {
    return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('developer preview should be noindex with canonical pointed to the Pilio online tool', async () => {
    const html = await readText('public/index.html');

    assert.match(html, /<meta\s+name="robots"\s+content="[^"]*noindex[^"]*nofollow[^"]*"/i);
    assert.match(
        html,
        /<link\s+rel="canonical"\s+href="https:\/\/pilio\.ai\/gemini-watermark-remover"\s*\/?>/i
    );
});

test('developer preview should visibly link most users back to the Pilio online tool', async () => {
    const html = await readText('public/index.html');

    assert.match(html, /data-i18n="preview\.notice"/);
    assert.match(html, /data-i18n="preview\.cta"/);
    assert.match(html, /href="https:\/\/pilio\.ai\/gemini-watermark-remover"/i);
});
