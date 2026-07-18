import path from 'node:path';

export const DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL = 'http://127.0.0.1:9226';
export const DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT = path.resolve(
  process.cwd(),
  '.artifacts/real-page-copy-download'
);
export const DEFAULT_REAL_PAGE_COPY_DOWNLOAD_PAGE_URL_PREFIX = 'https://gemini.google.com/';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function normalizeCdpUrl(value) {
  const normalized = String(value || '').trim();
  if (/^\d+$/.test(normalized)) {
    return `http://127.0.0.1:${normalized}`;
  }
  return normalized || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL;
}

export function parseExpectedImageSize(value, flagName) {
  const match = /^(\d+)[xX](\d+)$/.exec(String(value || '').trim());
  const width = Number(match?.[1] || 0);
  const height = Number(match?.[2] || 0);
  if (!match || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${flagName} must use WIDTHxHEIGHT with positive integers`);
  }
  return { width, height };
}

export function parseRealPageCopyDownloadCliArgs(argv = []) {
  const args = [...argv];
  const parsed = {
    cdpUrl: DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL,
    outputRoot: DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT,
    pageUrlPrefix: DEFAULT_REAL_PAGE_COPY_DOWNLOAD_PAGE_URL_PREFIX,
    expectedClipboardSize: null,
    expectedDownloadSize: null
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--cdp') {
      parsed.cdpUrl = normalizeCdpUrl(args.shift());
      continue;
    }
    if (arg === '--output-root') {
      parsed.outputRoot = path.resolve(process.cwd(), args.shift() || parsed.outputRoot);
      continue;
    }
    if (arg === '--page-prefix') {
      parsed.pageUrlPrefix = String(args.shift() || parsed.pageUrlPrefix).trim() || parsed.pageUrlPrefix;
      continue;
    }
    if (arg === '--expected-clipboard-size') {
      parsed.expectedClipboardSize = parseExpectedImageSize(args.shift(), arg);
      continue;
    }
    if (arg === '--expected-download-size') {
      parsed.expectedDownloadSize = parseExpectedImageSize(args.shift(), arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function inspectPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature or truncated IHDR');
  }
  if (buffer.readUInt32BE(8) < 13 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Invalid PNG IHDR');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new Error('Invalid PNG dimensions');
  }
  return { bytes: buffer.length, width, height };
}

function sanitizeObservedPathname(pathname, kinds) {
  if (kinds.includes('rd-gg')) {
    return pathname.replace(/\/(rd-gg(?:-dl)?)(?:\/.*)?$/i, '/$1/<redacted>').slice(0, 240);
  }
  if (kinds.includes('gg')) {
    return pathname.replace(/\/(gg(?:-dl)?)(?:\/.*)?$/i, '/$1/<redacted>').slice(0, 240);
  }
  return pathname.slice(0, 240);
}

export function classifyObservedRequest({ url = '', postData = '', phase = 'copy', method = 'GET' } = {}) {
  const textUrl = String(url || '');
  const textPostData = String(postData || '');
  let parsed;
  try {
    parsed = new URL(textUrl);
  } catch {
    return null;
  }

  const kinds = [];
  const isGoogleAssetHost = /(^|\.)googleusercontent\.com$/i.test(parsed.hostname);
  if (textUrl.includes('c8o8Fe') || textPostData.includes('c8o8Fe')) kinds.push('c8o8Fe');
  if (isGoogleAssetHost && /\/rd-gg(?:-dl)?\//i.test(parsed.pathname)) kinds.push('rd-gg');
  if (isGoogleAssetHost && /\/gg(?:-dl)?\//i.test(parsed.pathname)) kinds.push('gg');
  if (kinds.length === 0) return null;

  return {
    phase,
    kinds,
    method: String(method || 'GET').toUpperCase(),
    hostname: parsed.hostname,
    pathname: sanitizeObservedPathname(parsed.pathname, kinds)
  };
}

export function sanitizeGeminiPageUrl(value) {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'u' && segments[2] === 'app') {
      return `${parsed.origin}/u/<account>/app${segments[3] ? '/<conversation>' : ''}`;
    }
    if (segments[0] === 'app') {
      return `${parsed.origin}/app${segments[1] ? '/<conversation>' : ''}`;
    }
    return `${parsed.origin}/${segments[0] || ''}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function createInitialProbeReport(options = {}, generatedAt = new Date().toISOString()) {
  return {
    generatedAt,
    status: 'fail',
    stage: 'freshness',
    cdpUrl: options.cdpUrl || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL,
    pageUrl: '',
    freshness: { status: 'unavailable', exactMatch: false, reportPath: null },
    expectations: {
      clipboardSize: options.expectedClipboardSize || null,
      downloadSize: options.expectedDownloadSize || null
    },
    clipboard: {
      writeCalled: false,
      writeResolved: false,
      mimeType: '',
      validPng: false,
      bytes: 0,
      width: 0,
      height: 0,
      error: ''
    },
    download: {
      eventObserved: false,
      artifactPath: null,
      suggestedFilename: '',
      validPng: false,
      bytes: 0,
      width: 0,
      height: 0,
      sawC8o8Fe: false,
      sawPhysicalRdGg: false
    },
    network: [],
    dialogs: [],
    failures: []
  };
}

function addFailure(failures, code, message) {
  failures.push({ code, message });
}

function matchesSize(actual, expected) {
  return !expected || (actual.width === expected.width && actual.height === expected.height);
}

export function evaluateCopyDownloadProbe(report) {
  const failures = [];
  if (report.freshness?.status !== 'fresh' || report.freshness?.exactMatch !== true) {
    addFailure(failures, 'freshness-not-fresh', 'Installed userscript is not an exact fresh match');
  }
  if (!report.clipboard?.writeCalled) {
    addFailure(failures, 'clipboard-write-not-called', 'navigator.clipboard.write was not called');
  } else if (!report.clipboard?.writeResolved) {
    addFailure(failures, 'clipboard-write-failed', report.clipboard?.error || 'Clipboard write did not resolve');
  }
  if (!report.clipboard?.validPng || report.clipboard?.mimeType !== 'image/png' || report.clipboard?.bytes <= 0) {
    addFailure(failures, 'clipboard-png-invalid', 'Clipboard did not contain a valid non-empty image/png item');
  }
  if (report.clipboard?.validPng && !matchesSize(report.clipboard, report.expectations?.clipboardSize)) {
    addFailure(failures, 'clipboard-size-mismatch', 'Clipboard PNG dimensions do not match the expected size');
  }
  if (!report.download?.eventObserved || !report.download?.validPng || report.download?.bytes <= 0) {
    addFailure(failures, 'download-png-invalid', 'Native download did not produce a valid non-empty PNG');
  }
  if (!report.download?.sawC8o8Fe) {
    addFailure(failures, 'download-c8o8fe-missing', 'Download phase did not observe c8o8Fe');
  }
  if (!report.download?.sawPhysicalRdGg) {
    addFailure(failures, 'download-rd-gg-missing', 'Download phase did not observe a physical rd-gg request');
  }
  if ((report.dialogs || []).length > 0) {
    addFailure(failures, 'failure-dialog', 'A browser dialog appeared during the probe');
  }
  if (report.download?.validPng && !matchesSize(report.download, report.expectations?.downloadSize)) {
    addFailure(failures, 'download-size-mismatch', 'Downloaded PNG dimensions do not match the expected size');
  }
  return { status: failures.length === 0 ? 'pass' : 'fail', failures };
}
