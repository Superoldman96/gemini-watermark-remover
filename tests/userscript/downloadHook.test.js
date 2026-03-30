import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGeminiDownloadFetchHook,
  createGeminiDownloadRpcFetchHook,
  installGeminiDownloadRpcXmlHttpRequestHook,
  createGeminiDownloadIntentGate,
  extractGeminiAssetIdsFromRpcRequestBody,
  extractGeminiAssetBindingsFromResponseText,
  extractGeminiGeneratedAssetUrlsFromResponseText,
  extractGeminiOriginalAssetUrlsFromResponseText,
  isGeminiDownloadRpcUrl,
  isGeminiDownloadActionTarget
} from '../../src/userscript/downloadHook.js';
import { isGeminiOriginalAssetUrl } from '../../src/userscript/urlUtils.js';

test('createGeminiDownloadFetchHook should delegate non-target requests untouched', async () => {
  const calls = [];
  const originalFetch = async (...args) => {
    calls.push(args);
    return new Response('plain', {
      status: 200,
      headers: { 'content-type': 'text/plain' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => false,
    normalizeUrl: (url) => `${url}?normalized`,
    processBlob: async () => {
      throw new Error('should not run');
    }
  });

  const response = await hook('https://example.com/file.txt');

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://example.com/file.txt');
  assert.equal(await response.text(), 'plain');
});

test('createGeminiDownloadFetchHook should normalize Gemini asset url and replace response body with processed blob', async () => {
  const seenUrls = [];
  const originalFetch = async (input) => {
    seenUrls.push(typeof input === 'string' ? input : input.url);
    return new Response(new Blob(['original'], { type: 'image/png' }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png', 'x-source': 'origin' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: (url) => url.includes('googleusercontent.com'),
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async (blob) => {
      assert.equal(await blob.text(), 'original');
      return new Blob(['processed'], { type: 'image/png' });
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');

  assert.deepEqual(seenUrls, ['https://lh3.googleusercontent.com/rd-gg/token=s0']);
  assert.equal(await response.text(), 'processed');
  assert.equal(response.status, 200);
  assert.equal(response.statusText, 'OK');
  assert.equal(response.headers.get('x-source'), 'origin');
  assert.equal(response.headers.get('content-type'), 'image/png');
});

test('createGeminiDownloadFetchHook should pass a serializable processing context without the raw Response object', async () => {
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'image/png', 'x-source': 'origin' }
  });

  let seenContext = null;
  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/gg/token=s0-d-I?alr=yes',
    processBlob: async (_blob, context) => {
      seenContext = context;
      return new Blob(['processed'], { type: 'image/png' });
    }
  });

  await hook('https://lh3.googleusercontent.com/gg/token=d-I?alr=yes');

  assert.deepEqual(seenContext, {
    url: 'https://lh3.googleusercontent.com/gg/token=d-I?alr=yes',
    normalizedUrl: 'https://lh3.googleusercontent.com/gg/token=s0-d-I?alr=yes',
    responseStatus: 200,
    responseStatusText: 'OK',
    responseHeaders: {
      'content-type': 'image/png',
      'x-source': 'origin'
    }
  });
});

test('createGeminiDownloadFetchHook should bypass non-image Gemini responses', async () => {
  let processCalls = 0;
  const originalFetch = async () => new Response('https://lh3.google.com/rd-gg/token=s0-d-I?alr=yes', {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/plain; charset=UTF-8' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/gg/token=s0-d-I?alr=yes',
    processBlob: async () => {
      processCalls += 1;
      return new Blob(['processed'], { type: 'image/png' });
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/gg/token=s0-d-I?alr=yes');

  assert.equal(processCalls, 0);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=UTF-8');
  assert.equal(await response.text(), 'https://lh3.google.com/rd-gg/token=s0-d-I?alr=yes');
});

test('createGeminiDownloadFetchHook should fall back to original response when processing fails', async () => {
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: (url) => url,
    logger: { warn() {} },
    processBlob: async () => {
      throw new Error('boom');
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');

  assert.equal(await response.text(), 'original');
});

test('createGeminiDownloadFetchHook should reprocess repeated normalized url requests after the in-flight cache settles', async () => {
  let processCount = 0;
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async () => {
      processCount += 1;
      return new Blob([`processed-${processCount}`], { type: 'image/png' });
    }
  });

  const first = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');
  const second = await hook('https://lh3.googleusercontent.com/rd-gg/token=s512');

  assert.equal(await first.text(), 'processed-1');
  assert.equal(await second.text(), 'processed-2');
  assert.equal(processCount, 2);
});

test('createGeminiDownloadFetchHook should only keep in-flight cache entries and release them after success', async () => {
  let processCount = 0;
  let releaseProcessing = null;
  let notifyProcessingStarted = null;
  const processingStarted = new Promise((resolve) => {
    notifyProcessingStarted = resolve;
  });
  const cache = new Map();
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    cache,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async () => {
      processCount += 1;
      notifyProcessingStarted();
      await new Promise((resolve) => {
        releaseProcessing = resolve;
      });
      return new Blob([`processed-${processCount}`], { type: 'image/png' });
    }
  });

  const firstPromise = hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');
  const secondPromise = hook('https://lh3.googleusercontent.com/rd-gg/token=s512');
  await processingStarted;

  releaseProcessing();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(await first.text(), 'processed-1');
  assert.equal(await second.text(), 'processed-1');
  assert.equal(processCount, 1);
  assert.equal(cache.size, 0);
});

test('createGeminiDownloadFetchHook should bypass interception when gwr bypass flag is present', async () => {
  const calls = [];
  const originalFetch = async (...args) => {
    calls.push(args);
    return new Response('plain', {
      status: 200,
      headers: { 'content-type': 'text/plain' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    processBlob: async () => {
      throw new Error('should not run');
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024', {
    gwrBypass: true
  });

  assert.equal(await response.text(), 'plain');
  assert.equal(calls.length, 1);
});

test('createGeminiDownloadFetchHook should bypass Gemini preview fetches when only original/download assets are targeted', async () => {
  let processCalls = 0;
  const originalFetch = async (input) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    return new Response(url, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=UTF-8' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: isGeminiOriginalAssetUrl,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/gg/example-token=s0-rj?alr=yes',
    processBlob: async () => {
      processCalls += 1;
      return new Blob(['processed'], { type: 'image/png' });
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/gg/example-token=s1024-rj?alr=yes');

  assert.equal(processCalls, 0);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=UTF-8');
  assert.equal(
    await response.text(),
    'https://lh3.googleusercontent.com/gg/example-token=s1024-rj?alr=yes'
  );
});

test('isGeminiDownloadActionTarget should recognize copy and download buttons but ignore share actions', () => {
  assert.equal(isGeminiDownloadActionTarget({
    closest() {
      return {
        getAttribute(name) {
          return name === 'aria-label' ? '下载完整尺寸的图片' : '';
        },
        textContent: ''
      };
    }
  }), true);

  assert.equal(isGeminiDownloadActionTarget({
    closest() {
      return {
        getAttribute(name) {
          return name === 'aria-label' ? 'Copy image' : '';
        },
        textContent: ''
      };
    }
  }), true);

  assert.equal(isGeminiDownloadActionTarget({
    closest() {
      return {
        getAttribute(name) {
          return name === 'aria-label' ? '分享图片' : '';
        },
        textContent: ''
      };
    }
  }), false);
});

test('createGeminiDownloadIntentGate should arm only for explicit copy or download gestures', () => {
  let now = 100;
  const listeners = new Map();
  const targetWindow = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };

  const gate = createGeminiDownloadIntentGate({
    targetWindow,
    now: () => now,
    windowMs: 5000
  });

  listeners.get('click')?.({
    target: {
      closest() {
        return {
          getAttribute(name) {
            return name === 'aria-label' ? '分享图片' : '';
          },
          textContent: ''
        };
      }
    }
  });
  assert.equal(gate.hasRecentIntent(), false);

  listeners.get('click')?.({
    target: {
      closest() {
        return {
          getAttribute(name) {
            return name === 'aria-label' ? '复制图片' : '';
          },
          textContent: ''
        };
      }
    }
  });
  assert.equal(gate.hasRecentIntent(), true);

  now += 6000;
  assert.equal(gate.hasRecentIntent(), false);

  gate.dispose();
  assert.equal(listeners.size, 0);
});

test('createGeminiDownloadIntentGate should retain asset ids for the latest explicit download intent', () => {
  let now = 100;
  const listeners = new Map();
  const targetWindow = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };

  const gate = createGeminiDownloadIntentGate({
    targetWindow,
    now: () => now,
    windowMs: 5000,
    resolveMetadata: () => ({
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }
    })
  });

  listeners.get('click')?.({
    target: {
      closest() {
        return {
          getAttribute(name) {
            return name === 'aria-label' ? '下载完整尺寸的图片' : '';
          },
          textContent: ''
        };
      }
    }
  });

  assert.deepEqual(gate.getRecentIntentMetadata(), {
    assetIds: {
      responseId: 'r_d7ef418292ede05c',
      draftId: 'rc_2315ec0b5621fce5',
      conversationId: 'c_cdec91057e5fdcaf'
    }
  });

  now += 6000;
  assert.equal(gate.getRecentIntentMetadata(), null);
});

test('createGeminiDownloadFetchHook should bypass targeted Gemini asset requests until a processing intent is armed', async () => {
  const seenUrls = [];
  let processCalls = 0;
  let allowProcessing = false;
  const originalFetch = async (input) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    seenUrls.push(url);
    return new Response(new Blob(['original'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    });
  };

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: isGeminiOriginalAssetUrl,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg/token=s0',
    shouldProcessRequest: () => allowProcessing,
    processBlob: async () => {
      processCalls += 1;
      return new Blob(['processed'], { type: 'image/png' });
    }
  });

  const bypassed = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');
  assert.equal(await bypassed.text(), 'original');
  assert.equal(processCalls, 0);
  assert.deepEqual(seenUrls, ['https://lh3.googleusercontent.com/rd-gg/token=s1024']);

  allowProcessing = true;
  const processed = await hook('https://lh3.googleusercontent.com/rd-gg/token=s1024');
  assert.equal(await processed.text(), 'processed');
  assert.equal(processCalls, 1);
  assert.deepEqual(seenUrls, [
    'https://lh3.googleusercontent.com/rd-gg/token=s1024',
    'https://lh3.googleusercontent.com/rd-gg/token=s0'
  ]);
});

test('isGeminiDownloadRpcUrl should only match Gemini batchexecute download rpc requests', () => {
  assert.equal(
    isGeminiDownloadRpcUrl('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe&rt=c'),
    true
  );
  assert.equal(
    isGeminiDownloadRpcUrl('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&rt=c'),
    false
  );
  assert.equal(
    isGeminiDownloadRpcUrl('https://example.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe&rt=c'),
    false
  );
});

test('extractGeminiOriginalAssetUrlsFromResponseText should recover googleusercontent original asset urls from escaped rpc payloads', () => {
  const responseText = ')]}\'\n123\n[["wrb.fr","c8o8Fe","[null,\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/rd-gg-dl\\\\/token=s1024-rj?foo=1\\\",\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/rd-gg-dl\\\\/token=s1024-rj?foo=1\\\"]",null,null,null,"generic"]]';

  assert.deepEqual(extractGeminiOriginalAssetUrlsFromResponseText(responseText), [
    'https://lh3.googleusercontent.com/rd-gg-dl/token=s0-rj?foo=1'
  ]);
});

test('extractGeminiGeneratedAssetUrlsFromResponseText should recover normalized Gemini preview asset urls from escaped rpc payloads', () => {
  const responseText = ')]}\'\n123\n[["wrb.fr","hNvQHb","[[[[\\\"c_cdec91057e5fdcaf\\\",\\\"r_d7ef418292ede05c\\\",\\\"rc_2315ec0b5621fce5\\\"],[[[\\\"rc_1dfd19ae1152c42a\\\",[\\\"http://googleusercontent.com/image_generation_content/1\\\"],[null,null,null,null,[null,null,8]],null,null,null,null,null,[2],\\\"und\\\",null,null,[null,null,null,null,null,null,[3],[[[[null,null,null,[null,1,\\\"2399453241942556798.png\\\",\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/gg\\\\/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ\\\"]]]]]]]]]",null,null,null,"generic"]]';

  assert.deepEqual(extractGeminiGeneratedAssetUrlsFromResponseText(responseText), [
    'https://lh3.googleusercontent.com/gg/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ=s0'
  ]);
});

test('extractGeminiAssetIdsFromRpcRequestBody should recover response draft and conversation ids from encoded batchexecute payload', () => {
  const requestBody = 'f.req=%5Bnull%2C%22%5Bnull%2C%5B%5C%22image_generation_content%5C%22%2C0%2C%5C%22r_d7ef418292ede05c%5C%22%2C%5C%22rc_2315ec0b5621fce5%5C%22%2C%5C%22c_cdec91057e5fdcaf%5C%22%5D%5D%22%5D&at=abc';

  assert.deepEqual(extractGeminiAssetIdsFromRpcRequestBody(requestBody), {
    responseId: 'r_d7ef418292ede05c',
    draftId: 'rc_2315ec0b5621fce5',
    conversationId: 'c_cdec91057e5fdcaf'
  });
});

test('extractGeminiAssetBindingsFromResponseText should pair response asset ids with discovered Gemini asset urls', () => {
  const responseText = ')]}\'\n123\n[["wrb.fr","hNvQHb","[[[[\\\"c_cdec91057e5fdcaf\\\",\\\"r_d7ef418292ede05c\\\",\\\"rc_2315ec0b5621fce5\\\"],[[[\\\"rc_1dfd19ae1152c42a\\\",[\\\"http://googleusercontent.com/image_generation_content/1\\\"],[null,null,null,null,[null,null,8]],null,null,null,null,null,[2],\\\"und\\\",null,null,[null,null,null,null,null,null,[3],[[[[null,null,null,[null,1,\\\"2399453241942556798.png\\\",\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/gg\\\\/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ\\\"]]]]]]]]]",null,null,null,"generic"]]';

  assert.deepEqual(extractGeminiAssetBindingsFromResponseText(responseText), [{
    discoveredUrl: 'https://lh3.googleusercontent.com/gg/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ=s0',
    assetIds: {
      responseId: 'r_d7ef418292ede05c',
      draftId: 'rc_2315ec0b5621fce5',
      conversationId: 'c_cdec91057e5fdcaf'
    }
  }]);
});

test('extractGeminiAssetBindingsFromResponseText should still recover a usable binding when history tuples and content blocks are offset', () => {
  const responseText = ')]}\'\n123\n[["wrb.fr","hNvQHb","[[[[\\\"c_cdec91057e5fdcaf\\\",\\\"r_134f73283381ab82\\\",\\\"rc_e48e309fb05102e2\\\"],[\\\"c_cdec91057e5fdcaf\\\",\\\"r_8564c2370ec24b62\\\",\\\"rc_1dfd19ae1152c42a\\\"],[[\\\"性感，白皙，清纯\\\"],1,null,0,\\\"fbb127bbb056c959\\\",0,14,null,false,null,[]],[[[\\\"rc_e48e309fb05102e2\\\",[\\\"http://googleusercontent.com/image_generation_content/2\\\"],[null,null,null,null,[null,null,8]],null,null,null,null,null,[2],\\\"und\\\",null,null,[null,null,null,null,null,null,[3],[[[[null,null,null,[null,1,\\\"8289315647847911722.png\\\",\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/gg\\\\/AMW1TPoUzF0DJQYiXY7_Zpzxr1R77yq-C47kmFP35SHjv1jiPds5Sim4iy_N2Hho7mEicd7kf5vfjCCjCpn1c7IbqVbvkahV2G3Ciea0Z50SIDu_uL0JWCqI5OQRUZQnP99am2fIo41kPSPjQxRl7N_nVKHrtSn6Tgks6pBGfguzfdBfFTTrhsLJXMfC3ZehqcPKBj7X3yhgthbJCBMqo7VuqGkNNMaUawRdqEKGD0AXksBQN6FBSj1cy8sHPyApHK-XLMmQnb3BNwsayLUetPB3gkaw-qY-qTmjaN_zXHeJzW4_3YvB1aQ5hO-33kmP896VfyWQLiWeuInMem2cooiP54zt\\\"]]]]]]]]]",null,null,null,"generic"]]';

  assert.deepEqual(extractGeminiAssetBindingsFromResponseText(responseText), [{
    discoveredUrl: 'https://lh3.googleusercontent.com/gg/AMW1TPoUzF0DJQYiXY7_Zpzxr1R77yq-C47kmFP35SHjv1jiPds5Sim4iy_N2Hho7mEicd7kf5vfjCCjCpn1c7IbqVbvkahV2G3Ciea0Z50SIDu_uL0JWCqI5OQRUZQnP99am2fIo41kPSPjQxRl7N_nVKHrtSn6Tgks6pBGfguzfdBfFTTrhsLJXMfC3ZehqcPKBj7X3yhgthbJCBMqo7VuqGkNNMaUawRdqEKGD0AXksBQN6FBSj1cy8sHPyApHK-XLMmQnb3BNwsayLUetPB3gkaw-qY-qTmjaN_zXHeJzW4_3YvB1aQ5hO-33kmP896VfyWQLiWeuInMem2cooiP54zt=s0',
    assetIds: {
      responseId: 'r_8564c2370ec24b62',
      draftId: 'rc_1dfd19ae1152c42a',
      conversationId: 'c_cdec91057e5fdcaf'
    }
  }]);
});

test('extractGeminiAssetBindingsFromResponseText should align response order with later draft blocks when the first history tuple has no draft id', () => {
  const historyPayload = [[
    ['c_cdec91057e5fdcaf', 'r_8a95cf3da7dcab7d'],
    ['c_cdec91057e5fdcaf', 'r_19c04baf39a68931', 'rc_45d85da14e2d5ef4'],
    [['我喜欢少女'], 1, null, 0, 'fbb127bbb056c959', 0, 14, null, false, null, []],
    [[[
      'rc_33808c0f8008f500',
      ['http://googleusercontent.com/image_generation_content/4'],
      [null, null, null, null, [null, null, 8]],
      null,
      null,
      null,
      null,
      null,
      [2],
      'und',
      null,
      null,
      [
        null,
        null,
        null,
        null,
        null,
        null,
        [3],
        [[[[null, null, null, [
          null,
          1,
          '9531565739231490508.png',
          'https://lh3.googleusercontent.com/gg/AMW1TPp-e0_45VrFA-EWdr1L6KKaMyKsAQiBnonsEgxm1XhMhnARJhL8mCtxfBYwk3mR1qgy4IakOTXBaGRO_WIi28IMKmqJXLDz09jgfAa7XOD45TFp4q5kkbj'
        ]]]]]
      ]
    ]]]
  ]];
  const responseText = `)]}'\n123\n${JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(historyPayload), null, null, null, 'generic']])}`;

  assert.deepEqual(extractGeminiAssetBindingsFromResponseText(responseText), [{
    discoveredUrl: 'https://lh3.googleusercontent.com/gg/AMW1TPp-e0_45VrFA-EWdr1L6KKaMyKsAQiBnonsEgxm1XhMhnARJhL8mCtxfBYwk3mR1qgy4IakOTXBaGRO_WIi28IMKmqJXLDz09jgfAa7XOD45TFp4q5kkbj=s0',
    assetIds: {
      responseId: 'r_8a95cf3da7dcab7d',
      draftId: 'rc_33808c0f8008f500',
      conversationId: 'c_cdec91057e5fdcaf'
    }
  }]);
});

test('createGeminiDownloadRpcFetchHook should notify discovered original asset urls from download rpc responses', async () => {
  const seen = [];
  const originalFetch = async () => new Response(
    ')]}\'\n123\n[["wrb.fr","c8o8Fe","[null,\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/rd-gg-dl\\\\/token=s1024-rj\\\"]",null,null,null,"generic"]]',
    {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=UTF-8' }
    }
  );

  const hook = createGeminiDownloadRpcFetchHook({
    originalFetch,
    getIntentMetadata: () => ({
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }),
    onOriginalAssetDiscovered: (payload) => {
      seen.push(payload);
    }
  });

  const response = await hook('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe&rt=c');

  assert.equal(response.status, 200);
  assert.equal(await response.text(), ')]}\'\n123\n[["wrb.fr","c8o8Fe","[null,\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/rd-gg-dl\\\\/token=s1024-rj\\\"]",null,null,null,"generic"]]');
  assert.deepEqual(seen, [{
    rpcUrl: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe&rt=c',
    discoveredUrl: 'https://lh3.googleusercontent.com/rd-gg-dl/token=s0-rj',
    intentMetadata: {
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }
  }]);
});

test('createGeminiDownloadRpcFetchHook should fallback to parsing asset ids from rpc request body when recent intent metadata is missing', async () => {
  const seen = [];
  const originalFetch = async () => new Response(
    ')]}\'\n123\n[["wrb.fr","c8o8Fe","[null,\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/rd-gg-dl\\\\/token=s1024-rj\\\"]",null,null,null,"generic"]]',
    {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=UTF-8' }
    }
  );

  const hook = createGeminiDownloadRpcFetchHook({
    originalFetch,
    getIntentMetadata: () => null,
    onOriginalAssetDiscovered: (payload) => {
      seen.push(payload);
    }
  });

  await hook('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe&rt=c', {
    method: 'POST',
    body: 'f.req=%5Bnull%2C%22%5Bnull%2C%5B%5C%22image_generation_content%5C%22%2C0%2C%5C%22r_d7ef418292ede05c%5C%22%2C%5C%22rc_2315ec0b5621fce5%5C%22%2C%5C%22c_cdec91057e5fdcaf%5C%22%5D%5D%22%5D&at=abc'
  });

  assert.deepEqual(seen, [{
    rpcUrl: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe&rt=c',
    discoveredUrl: 'https://lh3.googleusercontent.com/rd-gg-dl/token=s0-rj',
    intentMetadata: {
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }
  }]);
});

test('createGeminiDownloadRpcFetchHook should inspect non-c8o8Fe Gemini batchexecute responses when asset ids and original urls are present', async () => {
  const seen = [];
  const originalFetch = async () => new Response(
    ')]}\'\n123\n[["wrb.fr","ESY5D","[null,\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/gg-dl\\\\/token=s1024-rj\\\"]",null,null,null,"generic"]]',
    {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=UTF-8' }
    }
  );

  const hook = createGeminiDownloadRpcFetchHook({
    originalFetch,
    getIntentMetadata: () => null,
    onOriginalAssetDiscovered: (payload) => {
      seen.push(payload);
    }
  });

  await hook('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&rt=c', {
    method: 'POST',
    body: 'f.req=%5Bnull%2C%22%5Bnull%2C%5B%5C%22image_generation_content%5C%22%2C0%2C%5C%22r_auto1234567890ab%5C%22%2C%5C%22rc_auto1234567890ab%5C%22%2C%5C%22c_auto1234567890ab%5C%22%5D%5D%22%5D&at=abc'
  });

  assert.deepEqual(seen, [{
    rpcUrl: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ESY5D&rt=c',
    discoveredUrl: 'https://lh3.googleusercontent.com/gg-dl/token=s0-rj',
    intentMetadata: {
      assetIds: {
        responseId: 'r_auto1234567890ab',
        draftId: 'rc_auto1234567890ab',
        conversationId: 'c_auto1234567890ab'
      }
    }
  }]);
});

test('createGeminiDownloadRpcFetchHook should use response-derived asset ids for Gemini preview urls in history payloads', async () => {
  const seen = [];
  const originalFetch = async () => new Response(
    ')]}\'\n123\n[["wrb.fr","hNvQHb","[[[[\\\"c_cdec91057e5fdcaf\\\",\\\"r_d7ef418292ede05c\\\",\\\"rc_2315ec0b5621fce5\\\"],[[[\\\"rc_1dfd19ae1152c42a\\\",[\\\"http://googleusercontent.com/image_generation_content/1\\\"],[null,null,null,null,[null,null,8]],null,null,null,null,null,[2],\\\"und\\\",null,null,[null,null,null,null,null,null,[3],[[[[null,null,null,[null,1,\\\"2399453241942556798.png\\\",\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/gg\\\\/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ\\\"]]]]]]]]]",null,null,null,"generic"]]',
    {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=UTF-8' }
    }
  );

  const hook = createGeminiDownloadRpcFetchHook({
    originalFetch,
    getIntentMetadata: () => ({
      assetIds: {
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }),
    onOriginalAssetDiscovered: (payload) => {
      seen.push(payload);
    }
  });

  await hook('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&rt=c', {
    method: 'POST',
    body: 'f.req=%5B%5B%5B%22hNvQHb%22%2C%22%5B%5C%22c_cdec91057e5fdcaf%5C%22%2C10%2Cnull%2C1%2C%5B0%5D%2C%5B4%5D%2Cnull%2C1%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&at=abc'
  });

  assert.deepEqual(seen, [{
    rpcUrl: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&rt=c',
    discoveredUrl: 'https://lh3.googleusercontent.com/gg/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ=s0',
    intentMetadata: {
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }
  }]);
});

test('installGeminiDownloadRpcXmlHttpRequestHook should inspect Gemini batchexecute XHR responses and notify response-derived asset bindings', async () => {
  const seen = [];

  class FakeXMLHttpRequest {
    constructor() {
      this.listeners = new Map();
      this.responseType = '';
      this.status = 0;
      this.responseText = '';
      this.response = '';
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      this.listeners.set(type, listeners.filter((entry) => entry !== listener));
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    send(body) {
      this.body = body;
    }

    dispatch(type) {
      for (const listener of this.listeners.get(type) || []) {
        listener.call(this, { type, target: this, currentTarget: this });
      }
    }

    respond({ status = 200, responseText = '' } = {}) {
      this.status = status;
      this.responseText = responseText;
      this.response = responseText;
      this.dispatch('loadend');
    }
  }

  const targetWindow = {
    XMLHttpRequest: FakeXMLHttpRequest
  };

  installGeminiDownloadRpcXmlHttpRequestHook(targetWindow, {
    getIntentMetadata: () => ({
      assetIds: {
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }),
    onOriginalAssetDiscovered: (payload) => {
      seen.push(payload);
    },
    logger: { warn() {} }
  });

  const xhr = new targetWindow.XMLHttpRequest();
  xhr.open('POST', 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&rt=c');
  xhr.send('f.req=%5B%5B%5B%22hNvQHb%22%2C%22%5B%5C%22c_cdec91057e5fdcaf%5C%22%2C10%2Cnull%2C1%2C%5B0%5D%2C%5B4%5D%2Cnull%2C1%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&at=abc');
  xhr.respond({
    status: 200,
    responseText: ')]}\'\n123\n[["wrb.fr","hNvQHb","[[[[\\\"c_cdec91057e5fdcaf\\\",\\\"r_d7ef418292ede05c\\\",\\\"rc_2315ec0b5621fce5\\\"],[[[\\\"rc_1dfd19ae1152c42a\\\",[\\\"http://googleusercontent.com/image_generation_content/1\\\"],[null,null,null,null,[null,null,8]],null,null,null,null,null,[2],\\\"und\\\",null,null,[null,null,null,null,null,null,[3],[[[[null,null,null,[null,1,\\\"2399453241942556798.png\\\",\\\"https:\\\\/\\\\/lh3.googleusercontent.com\\\\/gg\\\\/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ\\\"]]]]]]]]]",null,null,null,"generic"]]'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(seen, [{
    rpcUrl: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&rt=c',
    discoveredUrl: 'https://lh3.googleusercontent.com/gg/AMW1TPruenvvhqGkK0ivNZat8rOQAWX2D9MYOb3rnxDwPU2y0V9oAp2bsFbJaGpRuuRsL19W2GwrpLRLqs5NydfTKFgw1rS01x9Kw8LtVbLdozlk8xgDCA2JiQ2Zs-12nq3o1OoxCKkT2LDl0lstjozOVQLHVtPA3kTduYB8-vwLSw3mWY0EkGE6RaL5_-8nRGZKXMmfpfjKRwLeFBv129SAVZKrV_cd9vypDV_Kqf7RZv4cvvuS8iOdfgEVvBHfoPQ268hode9yEG4uafOs_cCKU_vrcI2Bv06Yu3zTjLn1YxHVbUzXbKKsywKxtNeiCvlpvoxgeIlF8x_GgMAWinNf46vQ=s0',
    intentMetadata: {
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }
  }]);
});

test('createGeminiDownloadFetchHook should forward recent intent metadata and notify discovered original assets', async () => {
  let notified = null;
  let seenContext = null;
  const originalFetch = async () => new Response(new Blob(['original'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });

  const hook = createGeminiDownloadFetchHook({
    originalFetch,
    isTargetUrl: () => true,
    normalizeUrl: () => 'https://lh3.googleusercontent.com/rd-gg-dl/token=s0',
    getIntentMetadata: () => ({
      assetIds: {
        responseId: 'r_d7ef418292ede05c',
        draftId: 'rc_2315ec0b5621fce5',
        conversationId: 'c_cdec91057e5fdcaf'
      }
    }),
    onOriginalAssetDiscovered: async (context) => {
      notified = context;
    },
    processBlob: async (_blob, context) => {
      seenContext = context;
      return new Blob(['processed'], { type: 'image/png' });
    }
  });

  const response = await hook('https://lh3.googleusercontent.com/rd-gg-dl/token=s1024');

  assert.equal(await response.text(), 'processed');
  assert.deepEqual(seenContext.intentMetadata, {
    assetIds: {
      responseId: 'r_d7ef418292ede05c',
      draftId: 'rc_2315ec0b5621fce5',
      conversationId: 'c_cdec91057e5fdcaf'
    }
  });
  assert.deepEqual(notified.intentMetadata, seenContext.intentMetadata);
  assert.equal(notified.normalizedUrl, 'https://lh3.googleusercontent.com/rd-gg-dl/token=s0');
});
