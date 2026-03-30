import {
  isGeminiGeneratedAssetUrl,
  isGeminiOriginalAssetUrl,
  normalizeGoogleusercontentImageUrl
} from './urlUtils.js';
import {
  appendCompatibleActionContext,
  createActionContextProvider,
  getActionContextFromIntentGate
} from '../shared/actionContextCompat.js';

function buildHookRequestArgs(args, normalizedUrl) {
  const nextArgs = [...args];
  const input = nextArgs[0];

  if (typeof input === 'string') {
    nextArgs[0] = normalizedUrl;
    return nextArgs;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    nextArgs[0] = new Request(normalizedUrl, input);
    return nextArgs;
  }

  nextArgs[0] = normalizedUrl;
  return nextArgs;
}

function hasHeaderValue(headersLike, headerName) {
  if (!headersLike) return false;
  const normalizedHeaderName = String(headerName || '').toLowerCase();

  if (typeof Headers !== 'undefined' && headersLike instanceof Headers) {
    return headersLike.get(normalizedHeaderName) === '1';
  }

  if (Array.isArray(headersLike)) {
    return headersLike.some(([name, value]) => String(name || '').toLowerCase() === normalizedHeaderName && String(value || '') === '1');
  }

  if (typeof headersLike === 'object') {
    for (const [name, value] of Object.entries(headersLike)) {
      if (String(name || '').toLowerCase() === normalizedHeaderName && String(value || '') === '1') {
        return true;
      }
    }
  }

  return false;
}

function shouldBypassHook(args) {
  const input = args[0];
  const init = args[1];

  if (init?.gwrBypass === true) {
    return true;
  }

  if (input && typeof input === 'object' && input.gwrBypass === true) {
    return true;
  }

  if (typeof Request !== 'undefined' && input instanceof Request && input.headers?.get('x-gwr-bypass') === '1') {
    return true;
  }

  return hasHeaderValue(init?.headers, 'x-gwr-bypass');
}

function buildProcessedResponse(response, blob) {
  const headers = new Headers(response.headers);
  if (blob.type) {
    headers.set('content-type', blob.type);
  }

  return new Response(blob, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function buildDirectBlobResponse(blob, mimeType = '') {
  const headers = new Headers();
  const resolvedMimeType = mimeType || blob?.type || 'application/octet-stream';
  if (resolvedMimeType) {
    headers.set('content-type', resolvedMimeType);
  }

  return new Response(blob, {
    status: 200,
    statusText: 'OK',
    headers
  });
}

function isImageResponse(response) {
  const contentType = response?.headers?.get?.('content-type') || '';
  if (!contentType) {
    return true;
  }
  return /^image\//i.test(contentType);
}

function serializeResponseHeaders(headers) {
  const entries = {};
  if (!headers || typeof headers.forEach !== 'function') {
    return entries;
  }
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  return entries;
}

function shouldReuseProcessedDownloadResource(actionContext) {
  return actionContext?.action === 'download'
    && actionContext?.resource?.kind === 'processed'
    && actionContext?.resource?.slot === 'full'
    && actionContext.resource.blob instanceof Blob;
}

const DOWNLOAD_ACTION_LABEL_PATTERN = /(download|copy|下载|复制)/i;
const COPY_ACTION_LABEL_PATTERN = /(copy|复制)/i;
const EXPLICIT_DOWNLOAD_ACTION_LABEL_PATTERN = /(download|下载)/i;
const INTENT_EVENT_TYPES = ['click', 'keydown'];
const DEFAULT_INTENT_WINDOW_MS = 5000;
const GEMINI_DOWNLOAD_RPC_HOST = 'gemini.google.com';
const GEMINI_DOWNLOAD_RPC_PATH = '/_/BardChatUi/data/batchexecute';
const GEMINI_DOWNLOAD_RPC_ID = 'c8o8Fe';
const GEMINI_GOOGLEUSERCONTENT_URL_PATTERN = /https:(?:(?:\\\\\/)|(?:\\\/)|\/){2}[^\s"'\]]*googleusercontent\.com(?:(?:\\\\\/)|(?:\\\/)|\/)[^\s"'\]]+/gi;
const GEMINI_RESPONSE_ID_PATTERN = /\br_[a-z0-9]+\b/i;
const GEMINI_DRAFT_ID_PATTERN = /\brc_[a-z0-9]+\b/i;
const GEMINI_CONVERSATION_ID_PATTERN = /\bc_[a-z0-9]+\b/i;
const GEMINI_RESPONSE_BINDING_PATTERN = /(?<conversationId>c_[a-z0-9]+)[\s\S]{0,96}?(?<responseId>r_[a-z0-9]+)[\s\S]{0,96}?(?<draftId>rc_[a-z0-9]+)/gi;
const GEMINI_DRAFT_URL_BLOCK_PATTERN = /(?<draftId>rc_[a-z0-9]+)(?:(?:\\\\")|")?,\[(?:(?:\\\\")|")http:\/\/googleusercontent\.com\/image_generation_content\/\d+(?:(?:\\\\")|")?\][\s\S]{0,2400}?(?<discoveredUrl>https:(?:(?:\\\\\/)|(?:\\\/)|\/){2}[^\s"'\]]*googleusercontent\.com(?:(?:\\\\\/)|(?:\\\/)|\/)[^\s"'\]]+)/gi;
const GEMINI_XHR_HOOK_STATE = Symbol('gwrGeminiRpcXhrState');
const GEMINI_XHR_HOOK_LISTENER = Symbol('gwrGeminiRpcXhrListener');

function normalizeActionLabel(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function collectButtonLikeLabels(element) {
  if (!element || typeof element !== 'object') {
    return [];
  }

  const button = typeof element.closest === 'function'
    ? element.closest('button,[role="button"]')
    : null;
  if (!button || typeof button !== 'object') {
    return [];
  }

  return [
    button.getAttribute?.('aria-label') || '',
    button.getAttribute?.('title') || '',
    button.innerText || '',
    button.textContent || ''
  ]
    .map(normalizeActionLabel)
    .filter(Boolean);
}

export function isGeminiDownloadActionTarget(target) {
  return collectButtonLikeLabels(target).some((label) => DOWNLOAD_ACTION_LABEL_PATTERN.test(label));
}

export function resolveGeminiActionKind(target) {
  const labels = collectButtonLikeLabels(target);
  if (labels.some((label) => COPY_ACTION_LABEL_PATTERN.test(label))) {
    return 'clipboard';
  }
  if (labels.some((label) => EXPLICIT_DOWNLOAD_ACTION_LABEL_PATTERN.test(label))) {
    return 'download';
  }
  return '';
}

export function createGeminiDownloadIntentGate({
  targetWindow = globalThis,
  now = () => Date.now(),
  windowMs = DEFAULT_INTENT_WINDOW_MS,
  resolveActionContext = null
} = {}) {
  let armedUntil = 0;
  let recentActionContext = null;
  let recentIntentTarget = null;

  function cloneActionContext(actionContext = null) {
    return actionContext && typeof actionContext === 'object'
      ? { ...actionContext }
      : null;
  }

  function arm(actionContext = null, target = null) {
    armedUntil = Math.max(armedUntil, now() + windowMs);
    recentActionContext = cloneActionContext(actionContext);
    recentIntentTarget = target || recentIntentTarget || null;
  }

  function hasRecentIntent() {
    return now() <= armedUntil;
  }

  function getRecentActionContext() {
    if (!hasRecentIntent()) {
      return null;
    }

    if (recentIntentTarget && typeof resolveActionContext === 'function') {
      const refreshedActionContext = cloneActionContext(
        resolveActionContext(recentIntentTarget, null)
      );
      if (refreshedActionContext) {
        recentActionContext = refreshedActionContext;
        return refreshedActionContext;
      }
    }

    return recentActionContext;
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') {
      return;
    }

    if (event.type === 'keydown') {
      const key = typeof event.key === 'string' ? event.key : '';
      if (key && key !== 'Enter' && key !== ' ') {
        return;
      }
    }

    if (isGeminiDownloadActionTarget(event.target)) {
      const actionContext = typeof resolveActionContext === 'function'
        ? resolveActionContext(event.target, event)
        : null;
      arm(actionContext, event.target);
    }
  }

  for (const eventType of INTENT_EVENT_TYPES) {
    targetWindow?.addEventListener?.(eventType, handleEvent, true);
  }

  return {
    arm,
    hasRecentIntent,
    getRecentActionContext,
    handleEvent,
    dispose() {
      for (const eventType of INTENT_EVENT_TYPES) {
        targetWindow?.removeEventListener?.(eventType, handleEvent, true);
      }
    }
  };
}

export function isGeminiDownloadRpcUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== GEMINI_DOWNLOAD_RPC_HOST) {
      return false;
    }
    if (parsed.pathname !== GEMINI_DOWNLOAD_RPC_PATH) {
      return false;
    }

    const rpcIds = (parsed.searchParams.get('rpcids') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return rpcIds.includes(GEMINI_DOWNLOAD_RPC_ID);
  } catch {
    return false;
  }
}

function isGeminiBatchExecuteUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.hostname === GEMINI_DOWNLOAD_RPC_HOST
      && parsed.pathname === GEMINI_DOWNLOAD_RPC_PATH;
  } catch {
    return false;
  }
}

function decodeEscapedRpcUrl(rawUrl) {
  let decodedUrl = String(rawUrl || '').trim();
  if (!decodedUrl) {
    return '';
  }

  decodedUrl = decodedUrl
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003f/gi, '?')
    .replace(/\\u003a/gi, ':');

  let previous = '';
  while (decodedUrl !== previous) {
    previous = decodedUrl;
    decodedUrl = decodedUrl
      .replace(/\\\\\//g, '/')
      .replace(/\\\//g, '/');
  }

  return decodedUrl
    .replace(/[\\"]+$/g, '')
    .trim();
}

function decodeRpcRequestBodyText(rawText) {
  let decodedText = String(rawText || '').trim();
  if (!decodedText) {
    return '';
  }

  let previous = '';
  let attempts = 0;
  while (decodedText !== previous && attempts < 3) {
    previous = decodedText;
    attempts += 1;
    try {
      decodedText = decodeURIComponent(decodedText.replace(/\+/g, '%20'));
    } catch {
      break;
    }
  }

  return decodedText;
}

function matchGeminiAssetIds(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }

  const responseId = text.match(GEMINI_RESPONSE_ID_PATTERN)?.[0] || null;
  const draftId = text.match(GEMINI_DRAFT_ID_PATTERN)?.[0] || null;
  const conversationId = text.match(GEMINI_CONVERSATION_ID_PATTERN)?.[0] || null;
  if (!responseId && !draftId && !conversationId) {
    return null;
  }

  return {
    responseId,
    draftId,
    conversationId
  };
}

export function extractGeminiAssetIdsFromRpcRequestBody(body) {
  const candidateTexts = [];

  if (typeof body === 'string') {
    candidateTexts.push(body);
    try {
      const searchParams = new URLSearchParams(body);
      const requestPayload = searchParams.get('f.req');
      if (requestPayload) {
        candidateTexts.push(requestPayload);
      }
    } catch {
      // Ignore invalid search-params payloads and continue with the raw body.
    }
  } else if (body instanceof URLSearchParams) {
    candidateTexts.push(body.toString());
    const requestPayload = body.get('f.req');
    if (requestPayload) {
      candidateTexts.push(requestPayload);
    }
  } else {
    return null;
  }

  for (const candidateText of candidateTexts) {
    const assetIds = matchGeminiAssetIds(candidateText)
      || matchGeminiAssetIds(decodeRpcRequestBodyText(candidateText));
    if (assetIds) {
      return assetIds;
    }
  }

  return null;
}

async function extractGeminiAssetIdsFromRpcRequestArgs(args) {
  const input = args[0];
  const init = args[1];
  const initBodyAssetIds = extractGeminiAssetIdsFromRpcRequestBody(init?.body);
  if (initBodyAssetIds) {
    return initBodyAssetIds;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      const requestText = await input.clone().text();
      return extractGeminiAssetIdsFromRpcRequestBody(requestText);
    } catch {
      return null;
    }
  }

  return null;
}

export function extractGeminiOriginalAssetUrlsFromResponseText(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) {
    return [];
  }

  const discoveredUrls = new Set();
  for (const match of responseText.matchAll(GEMINI_GOOGLEUSERCONTENT_URL_PATTERN)) {
    const candidateUrl = decodeEscapedRpcUrl(match[0]);
    const normalizedUrl = normalizeGoogleusercontentImageUrl(candidateUrl);
    if (!isGeminiOriginalAssetUrl(normalizedUrl)) {
      continue;
    }
    discoveredUrls.add(normalizedUrl);
  }

  return Array.from(discoveredUrls);
}

export function extractGeminiGeneratedAssetUrlsFromResponseText(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) {
    return [];
  }

  const discoveredUrls = new Set();
  for (const match of responseText.matchAll(GEMINI_GOOGLEUSERCONTENT_URL_PATTERN)) {
    const candidateUrl = decodeEscapedRpcUrl(match[0]);
    const normalizedUrl = normalizeGoogleusercontentImageUrl(candidateUrl);
    if (!isGeminiGeneratedAssetUrl(normalizedUrl)) {
      continue;
    }
    discoveredUrls.add(normalizedUrl);
  }

  return Array.from(discoveredUrls);
}

function parseGeminiHistoryPayloadsFromResponseText(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) {
    return [];
  }

  const payloads = [];
  for (const line of responseText.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('[[')) {
      continue;
    }

    let parsedLine = null;
    try {
      parsedLine = JSON.parse(trimmedLine);
    } catch {
      continue;
    }

    if (!Array.isArray(parsedLine)) {
      continue;
    }

    for (const entry of parsedLine) {
      const rpcId = Array.isArray(entry) ? entry[1] : '';
      const innerPayloadText = Array.isArray(entry) ? entry[2] : '';
      if (rpcId !== 'hNvQHb' || typeof innerPayloadText !== 'string' || innerPayloadText.length === 0) {
        continue;
      }

      try {
        const innerPayload = JSON.parse(innerPayloadText);
        if (Array.isArray(innerPayload)) {
          payloads.push(innerPayload);
        }
      } catch {
        // Ignore malformed inner payloads and keep the regex fallback below.
      }
    }
  }

  return payloads;
}

function isGeminiResponseTuple(value) {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'string'
    && value[0].startsWith('c_')
    && typeof value[1] === 'string'
    && value[1].startsWith('r_');
}

function collectGeminiResponseSequence(node, sequence = [], seen = new Map()) {
  if (!Array.isArray(node)) {
    return sequence;
  }

  if (isGeminiResponseTuple(node)) {
    const conversationId = node[0];
    const responseId = node[1];
    const draftId = typeof node[2] === 'string' && node[2].startsWith('rc_')
      ? node[2]
      : null;
    const responseKey = `${conversationId}|${responseId}`;
    const existing = seen.get(responseKey);
    if (existing) {
      if (!existing.draftId && draftId) {
        existing.draftId = draftId;
      }
      return sequence;
    }

    const entry = {
      conversationId,
      responseId,
      draftId
    };
    seen.set(responseKey, entry);
    sequence.push(entry);
    return sequence;
  }

  for (const item of node) {
    collectGeminiResponseSequence(item, sequence, seen);
  }

  return sequence;
}

function collectGeminiGeneratedUrlsFromParsedNode(node, urls = new Set()) {
  if (typeof node === 'string') {
    const normalizedUrl = normalizeGoogleusercontentImageUrl(decodeEscapedRpcUrl(node));
    if (isGeminiGeneratedAssetUrl(normalizedUrl)) {
      urls.add(normalizedUrl);
    }
    return urls;
  }

  if (!Array.isArray(node)) {
    return urls;
  }

  for (const item of node) {
    collectGeminiGeneratedUrlsFromParsedNode(item, urls);
  }

  return urls;
}

function collectGeminiDraftBlocksFromParsedNode(node, blocks = []) {
  if (!Array.isArray(node)) {
    return blocks;
  }

  if (typeof node[0] === 'string' && node[0].startsWith('rc_')) {
    const discoveredUrls = Array.from(collectGeminiGeneratedUrlsFromParsedNode(node));
    if (discoveredUrls.length > 0) {
      blocks.push({
        draftId: node[0],
        discoveredUrls
      });
    }
    return blocks;
  }

  for (const item of node) {
    collectGeminiDraftBlocksFromParsedNode(item, blocks);
  }

  return blocks;
}

function extractGeminiAssetBindingsFromParsedHistoryNode(historyNode) {
  if (!Array.isArray(historyNode)) {
    return [];
  }

  const responseSequence = collectGeminiResponseSequence(historyNode);
  const draftBlocks = collectGeminiDraftBlocksFromParsedNode(historyNode);
  if (responseSequence.length === 0 || draftBlocks.length === 0) {
    return [];
  }

  const bindings = [];
  const pairCount = Math.min(responseSequence.length, draftBlocks.length);
  for (let index = 0; index < pairCount; index += 1) {
    const responseEntry = responseSequence[index];
    const draftBlock = draftBlocks[index];
    const resolvedDraftId = (
      responseSequence.length === 1
      && draftBlocks.length === 1
      && responseEntry.draftId
    )
      ? responseEntry.draftId
      : (draftBlock.draftId || responseEntry.draftId || null);

    for (const discoveredUrl of draftBlock.discoveredUrls) {
      bindings.push({
        discoveredUrl,
        assetIds: {
          responseId: responseEntry.responseId,
          draftId: resolvedDraftId,
          conversationId: responseEntry.conversationId
        }
      });
    }
  }

  return bindings;
}

function collectGeminiResponseBindingAnchors(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) {
    return [];
  }

  const anchors = [];
  for (const match of responseText.matchAll(GEMINI_RESPONSE_BINDING_PATTERN)) {
    const conversationId = match.groups?.conversationId || null;
    const responseId = match.groups?.responseId || null;
    const draftId = match.groups?.draftId || null;
    if (!conversationId && !responseId && !draftId) {
      continue;
    }

    anchors.push({
      index: match.index ?? 0,
      assetIds: {
        responseId,
        draftId,
        conversationId
      }
    });
  }

  return anchors;
}

function collectGeminiDraftUrlBlocks(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) {
    return [];
  }

  const blocks = [];
  for (const match of responseText.matchAll(GEMINI_DRAFT_URL_BLOCK_PATTERN)) {
    const draftId = match.groups?.draftId || null;
    const discoveredUrl = normalizeGoogleusercontentImageUrl(
      decodeEscapedRpcUrl(match.groups?.discoveredUrl || '')
    );
    if (!draftId || !isGeminiGeneratedAssetUrl(discoveredUrl)) {
      continue;
    }

    blocks.push({
      index: match.index ?? 0,
      draftId,
      discoveredUrl
    });
  }

  return blocks;
}

export function extractGeminiAssetBindingsFromResponseText(responseText) {
  if (typeof responseText !== 'string' || responseText.length === 0) {
    return [];
  }

  const structuredBindings = [];
  const seenStructuredBindings = new Set();
  for (const historyPayload of parseGeminiHistoryPayloadsFromResponseText(responseText)) {
    for (const historyNode of historyPayload) {
      for (const binding of extractGeminiAssetBindingsFromParsedHistoryNode(historyNode)) {
        const bindingKey = `${binding.assetIds.conversationId || ''}|${binding.assetIds.responseId || ''}|${binding.assetIds.draftId || ''}|${binding.discoveredUrl}`;
        if (seenStructuredBindings.has(bindingKey)) {
          continue;
        }
        seenStructuredBindings.add(bindingKey);
        structuredBindings.push(binding);
      }
    }
  }
  if (structuredBindings.length > 0) {
    return structuredBindings;
  }

  const anchors = collectGeminiResponseBindingAnchors(responseText);
  if (anchors.length === 0) {
    return [];
  }

  const bindings = [];
  const seenBindings = new Set();
  const draftUrlBlocks = collectGeminiDraftUrlBlocks(responseText);

  for (const block of draftUrlBlocks) {
    const matchingAnchor = [...anchors]
      .reverse()
      .find((anchor) => anchor.index < block.index && anchor.assetIds.draftId === block.draftId);
    if (!matchingAnchor) {
      continue;
    }

    const bindingKey = `${matchingAnchor.assetIds.conversationId || ''}|${matchingAnchor.assetIds.responseId || ''}|${matchingAnchor.assetIds.draftId || ''}|${block.discoveredUrl}`;
    if (seenBindings.has(bindingKey)) {
      continue;
    }
    seenBindings.add(bindingKey);
    bindings.push({
      discoveredUrl: block.discoveredUrl,
      assetIds: {
        ...matchingAnchor.assetIds
      }
    });
  }

  if (bindings.length > 0) {
    return bindings;
  }

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const nextAnchor = anchors[index + 1];
    const segment = responseText.slice(anchor.index, nextAnchor?.index ?? responseText.length);
    const discoveredUrls = extractGeminiGeneratedAssetUrlsFromResponseText(segment);
    for (const discoveredUrl of discoveredUrls) {
      const bindingKey = `${anchor.assetIds.conversationId || ''}|${anchor.assetIds.responseId || ''}|${anchor.assetIds.draftId || ''}|${discoveredUrl}`;
      if (seenBindings.has(bindingKey)) {
        continue;
      }
      seenBindings.add(bindingKey);
      bindings.push({
        discoveredUrl,
        assetIds: {
          ...anchor.assetIds
        }
      });
    }
  }

  return bindings;
}

function mergeGeminiActionContext(actionContext, assetIds) {
  const baseActionContext = actionContext && typeof actionContext === 'object'
    ? { ...actionContext }
    : {};
  const mergedAssetIds = {
    ...(baseActionContext.assetIds && typeof baseActionContext.assetIds === 'object'
      ? baseActionContext.assetIds
      : {}),
    ...(assetIds && typeof assetIds === 'object' ? assetIds : {})
  };

  if (!mergedAssetIds.responseId && !mergedAssetIds.draftId && !mergedAssetIds.conversationId) {
    return Object.keys(baseActionContext).length > 0 ? baseActionContext : null;
  }

  return {
    ...baseActionContext,
    assetIds: mergedAssetIds
  };
}

async function notifyGeminiOriginalAssetsFromRpcPayload({
  rpcUrl,
  requestAssetIds = null,
  responseText = '',
  provideActionContext = () => null,
  onOriginalAssetDiscovered = null
} = {}) {
  const actionContext = provideActionContext({ rpcUrl });
  const resolvedActionContext = mergeGeminiActionContext(
    actionContext,
    requestAssetIds
  );
  if (typeof onOriginalAssetDiscovered !== 'function') {
    return;
  }

  const responseBindings = extractGeminiAssetBindingsFromResponseText(responseText);
  if (responseBindings.length > 0) {
    for (const binding of responseBindings) {
      const mergedActionContext = mergeGeminiActionContext(
        resolvedActionContext,
        binding.assetIds
      );
      await onOriginalAssetDiscovered(appendCompatibleActionContext({
        rpcUrl,
        discoveredUrl: binding.discoveredUrl
      }, mergedActionContext));
    }
    return;
  }

  if (!resolvedActionContext) {
    return;
  }

  const discoveredUrls = extractGeminiOriginalAssetUrlsFromResponseText(responseText);
  for (const discoveredUrl of discoveredUrls) {
    await onOriginalAssetDiscovered(appendCompatibleActionContext({
      rpcUrl,
      discoveredUrl
    }, resolvedActionContext));
  }
}

export function createGeminiDownloadRpcFetchHook({
  originalFetch,
  provideActionContext = null,
  getActionContext = () => null,
  onOriginalAssetDiscovered = null,
  logger = console
}) {
  if (typeof originalFetch !== 'function') {
    throw new TypeError('originalFetch must be a function');
  }

  const resolveActionContextProvider = typeof provideActionContext === 'function'
    ? provideActionContext
    : createActionContextProvider({ getActionContext });

  return async function geminiDownloadRpcFetchHook(...args) {
    if (shouldBypassHook(args)) {
      return originalFetch(...args);
    }

    const input = args[0];
    const rpcUrl = typeof input === 'string' ? input : input?.url;
    if (!isGeminiBatchExecuteUrl(rpcUrl)) {
      return originalFetch(...args);
    }

    const response = await originalFetch(...args);
    if (!response?.ok || typeof response.clone !== 'function') {
      return response;
    }

    try {
      const requestAssetIds = await extractGeminiAssetIdsFromRpcRequestArgs(args);
      const responseText = await response.clone().text();
      await notifyGeminiOriginalAssetsFromRpcPayload({
        rpcUrl,
        requestAssetIds,
        responseText,
        provideActionContext: () => resolveActionContextProvider({ args, rpcUrl }),
        onOriginalAssetDiscovered
      });
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Download RPC hook processing failed:', error);
    }

    return response;
  };
}

export function installGeminiDownloadRpcXmlHttpRequestHook(targetWindow, {
  provideActionContext = null,
  getActionContext = () => null,
  onOriginalAssetDiscovered = null,
  logger = console
} = {}) {
  if (!targetWindow || typeof targetWindow !== 'object') {
    throw new TypeError('targetWindow must be an object');
  }

  const XMLHttpRequestCtor = targetWindow.XMLHttpRequest;
  const prototype = XMLHttpRequestCtor?.prototype;
  if (typeof XMLHttpRequestCtor !== 'function'
    || !prototype
    || typeof prototype.open !== 'function'
    || typeof prototype.send !== 'function') {
    return null;
  }

  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const resolveActionContextProvider = typeof provideActionContext === 'function'
    ? provideActionContext
    : createActionContextProvider({ getActionContext });

  prototype.open = function gwrGeminiRpcOpen(method, url, ...rest) {
    this[GEMINI_XHR_HOOK_STATE] = {
      rpcUrl: typeof url === 'string' ? url : String(url || ''),
      requestBody: null
    };
    return originalOpen.call(this, method, url, ...rest);
  };

  prototype.send = function gwrGeminiRpcSend(body) {
    const state = this[GEMINI_XHR_HOOK_STATE] || {
      rpcUrl: '',
      requestBody: null
    };
    state.requestBody = body;
    this[GEMINI_XHR_HOOK_STATE] = state;

    if (!this[GEMINI_XHR_HOOK_LISTENER] && typeof this.addEventListener === 'function') {
      const handleLoadEnd = () => {
        const currentState = this[GEMINI_XHR_HOOK_STATE];
        const rpcUrl = currentState?.rpcUrl || '';
        if (!isGeminiBatchExecuteUrl(rpcUrl)) {
          return;
        }
        if (typeof this.status === 'number' && (this.status < 200 || this.status >= 300)) {
          return;
        }
        if (this.responseType && this.responseType !== 'text') {
          return;
        }

        const responseText = typeof this.responseText === 'string'
          ? this.responseText
          : (typeof this.response === 'string' ? this.response : '');
        if (!responseText) {
          return;
        }

        void notifyGeminiOriginalAssetsFromRpcPayload({
          rpcUrl,
          requestAssetIds: extractGeminiAssetIdsFromRpcRequestBody(currentState?.requestBody),
          responseText,
          provideActionContext: resolveActionContextProvider,
          onOriginalAssetDiscovered
        }).catch((error) => {
          logger?.warn?.('[Gemini Watermark Remover] Download RPC XHR hook processing failed:', error);
        });
      };
      this[GEMINI_XHR_HOOK_LISTENER] = handleLoadEnd;
      this.addEventListener('loadend', handleLoadEnd);
    }

    return originalSend.call(this, body);
  };

  return {
    dispose() {
      prototype.open = originalOpen;
      prototype.send = originalSend;
    }
  };
}

export function createGeminiDownloadFetchHook({
  originalFetch,
  isTargetUrl,
  normalizeUrl,
  processBlob,
  provideActionContext = null,
  getActionContext = () => null,
  onOriginalAssetDiscovered = null,
  shouldProcessRequest = () => true,
  logger = console,
  cache = new Map()
}) {
  if (typeof originalFetch !== 'function') {
    throw new TypeError('originalFetch must be a function');
  }
  if (typeof isTargetUrl !== 'function') {
    throw new TypeError('isTargetUrl must be a function');
  }
  if (typeof normalizeUrl !== 'function') {
    throw new TypeError('normalizeUrl must be a function');
  }
  if (typeof processBlob !== 'function') {
    throw new TypeError('processBlob must be a function');
  }
  if (typeof shouldProcessRequest !== 'function') {
    throw new TypeError('shouldProcessRequest must be a function');
  }
  const resolveActionContextProvider = typeof provideActionContext === 'function'
    ? provideActionContext
    : createActionContextProvider({ getActionContext });

  return async function geminiDownloadFetchHook(...args) {
    if (shouldBypassHook(args)) {
      return originalFetch(...args);
    }

    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url;
    if (!isTargetUrl(url)) {
      return originalFetch(...args);
    }
    if (!shouldProcessRequest({ args, url })) {
      return originalFetch(...args);
    }

    const normalizedUrl = normalizeUrl(url);
    const resolvedActionContext = resolveActionContextProvider({ args, url, normalizedUrl });
    if (shouldReuseProcessedDownloadResource(resolvedActionContext)) {
      return buildDirectBlobResponse(
        resolvedActionContext.resource.blob,
        resolvedActionContext.resource.mimeType || ''
      );
    }

    const hookArgs = buildHookRequestArgs(args, normalizedUrl);
    const response = await originalFetch(...hookArgs);
    if (!response?.ok) {
      return response;
    }
    if (!isImageResponse(response)) {
      return response;
    }

    const fallbackResponse = typeof response.clone === 'function' ? response.clone() : response;

    try {
      let pendingBlob = cache.get(normalizedUrl);
      if (!pendingBlob) {
        pendingBlob = response.blob()
          .then(async (blob) => {
            const processingContext = {
              url,
              normalizedUrl,
              responseStatus: response.status,
              responseStatusText: response.statusText,
              responseHeaders: serializeResponseHeaders(response.headers)
            };
            if (resolvedActionContext != null) {
              processingContext.actionContext = resolvedActionContext;
            }
            if (typeof onOriginalAssetDiscovered === 'function') {
              await onOriginalAssetDiscovered(
                appendCompatibleActionContext(processingContext, resolvedActionContext)
              );
            }
            return processBlob(blob, processingContext);
          })
          .finally(() => {
            if (cache.get(normalizedUrl) === pendingBlob) {
              cache.delete(normalizedUrl);
            }
          });
        cache.set(normalizedUrl, pendingBlob);
      }

      const processedBlob = await pendingBlob;
      return buildProcessedResponse(response, processedBlob);
    } catch (error) {
      logger?.warn?.('[Gemini Watermark Remover] Download hook processing failed:', error);
      return fallbackResponse;
    }
  };
}

export function installGeminiDownloadHook(targetWindow, options) {
  if (!targetWindow || typeof targetWindow !== 'object') {
    throw new TypeError('targetWindow must be an object');
  }

  const intentGate = options?.intentGate || createGeminiDownloadIntentGate({
    targetWindow,
    resolveActionContext: options?.resolveActionContext
  });
  const originalFetch = typeof options?.originalFetch === 'function'
    ? options.originalFetch
    : targetWindow.fetch;
  const hook = createGeminiDownloadFetchHook({
    ...options,
    getActionContext: () => getActionContextFromIntentGate(intentGate),
    shouldProcessRequest: options?.shouldProcessRequest || (() => intentGate.hasRecentIntent()),
    originalFetch
  });

  targetWindow.fetch = hook;
  return hook;
}
