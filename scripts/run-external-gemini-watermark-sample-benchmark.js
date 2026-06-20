import path from 'node:path';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { loadLocalEnv } from './local-env.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

loadLocalEnv();

const DEFAULT_SAMPLE_ROOT = path.resolve(process.env.GWR_SAMPLE_ROOT || 'sample-files/gemini-watermark');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/sample-files-gemini-watermark');
const DEFAULT_OUTPUT_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-report.json');
const DEFAULT_MARKDOWN_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-report.md');
const DEFAULT_FAILURES_CSV_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-strong-located-failures.csv');
const DEFAULT_BASELINE_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-report.json');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const RESIDUAL_FAIL_THRESHOLD = 0.22;
const MIN_EXPECTED_SUPPRESSION_GAIN = 0.3;
const CONSERVATIVE_CANONICAL_96_MAX_GRADIENT = 0.08;
const CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN = 0.38;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_SPATIAL = 0.55;
const CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_GRADIENT = 0.2;

function parseArgs(argv) {
    const parsed = {
        sampleRoot: DEFAULT_SAMPLE_ROOT,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        failuresCsvPath: DEFAULT_FAILURES_CSV_PATH,
        baselinePath: DEFAULT_BASELINE_PATH
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || parsed.sampleRoot);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(args.shift() || parsed.markdownPath);
        } else if (arg === '--failures-csv') {
            parsed.failuresCsvPath = path.resolve(args.shift() || parsed.failuresCsvPath);
        } else if (arg === '--baseline') {
            parsed.baselinePath = path.resolve(args.shift() || parsed.baselinePath);
        }
    }

    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function normalizePathForReport(filePath) {
    return filePath.replace(/\\/g, '/');
}

function inferSampleGroup(relativePath) {
    const firstSegment = relativePath.split('/')[0] || 'root';
    return /^\d{4}-\d{2}-\d{2}$/.test(firstSegment) ? 'task-source' : firstSegment;
}

function formatRate(pass, total) {
    return total > 0 ? `${(pass / total * 100).toFixed(2)}%` : '0.00%';
}

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundNumber(value, digits = 6) {
    if (!Number.isFinite(value)) return null;
    return Number(value.toFixed(digits));
}

function resolveAlphaMaps() {
    const alpha48 = getEmbeddedAlphaMap(48);
    const alpha96 = getEmbeddedAlphaMap(96);
    const alpha96NewMargin = getEmbeddedAlphaMap('96-20260520');
    const alpha36V2 = getEmbeddedAlphaMap('36-v2');
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin],
        ['36-v2', alpha36V2]
    ]);

    return {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (cache.has(size)) return cache.get(size);
            if (typeof size === 'string') return null;
            const alphaMap = interpolateAlphaMap(alpha96, 96, size);
            cache.set(size, alphaMap);
            return alphaMap;
        }
    };
}

async function listImages(root) {
    const images = [];

    async function visit(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await visit(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

            const relativePath = normalizePathForReport(path.relative(root, fullPath));
            images.push({
                fileName: relativePath,
                filePath: fullPath,
                group: inferSampleGroup(relativePath)
            });
        }
    }

    await visit(root);
    return images.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function isConservativeCanonical96Pass(record) {
    const anchor = record.actualAnchor;
    const alphaGain = toFiniteNumber(record.alphaGain);
    const processedGradientScore = toFiniteNumber(record.processedGradientScore);
    const originalSpatialScore = toFiniteNumber(record.originalSpatialScore);
    const originalGradientScore = toFiniteNumber(record.originalGradientScore);
    const suppressionGain = toFiniteNumber(record.suppressionGain);

    return anchor?.logoSize === 96 &&
        anchor.marginRight === 64 &&
        anchor.marginBottom === 64 &&
        alphaGain !== null &&
        alphaGain <= 1 &&
        processedGradientScore !== null &&
        processedGradientScore <= CONSERVATIVE_CANONICAL_96_MAX_GRADIENT &&
        originalSpatialScore !== null &&
        originalSpatialScore >= CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_SPATIAL &&
        originalGradientScore !== null &&
        originalGradientScore >= CONSERVATIVE_CANONICAL_96_MIN_ORIGINAL_GRADIENT &&
        suppressionGain !== null &&
        suppressionGain >= CONSERVATIVE_CANONICAL_96_MIN_SUPPRESSION_GAIN;
}

export function classifyExternalBenchmarkCase(record) {
    if (record.applied !== true) {
        return {
            status: 'fail',
            bucket: 'missed-detection'
        };
    }

    if (
        toFiniteNumber(record.residualScore) !== null &&
        record.residualScore >= RESIDUAL_FAIL_THRESHOLD
    ) {
        if (isConservativeCanonical96Pass(record)) {
            return {
                status: 'pass',
                bucket: 'pass'
            };
        }
        if (
            toFiniteNumber(record.suppressionGain) === null ||
            record.suppressionGain < MIN_EXPECTED_SUPPRESSION_GAIN
        ) {
            return {
                status: 'fail',
                bucket: 'weak-suppression'
            };
        }
        return {
            status: 'fail',
            bucket: 'residual-edge'
        };
    }

    if (record.decisionTier === 'insufficient' || record.decisionTier == null) {
        return {
            status: 'fail',
            bucket: 'attribution-mismatch'
        };
    }

    return {
        status: 'pass',
        bucket: 'pass'
    };
}

function anchorKey(anchor) {
    if (!anchor) return 'none';
    const suffix = anchor.alphaVariant ? `/${anchor.alphaVariant}` : '';
    return `${anchor.logoSize}/${anchor.marginRight}/${anchor.marginBottom}${suffix}`;
}

function incrementBucket(map, key, status) {
    if (!map[key]) {
        map[key] = {
            total: 0,
            pass: 0,
            fail: 0,
            rate: 0,
            buckets: {}
        };
    }
    map[key].total++;
    if (status.status === 'pass') map[key].pass++;
    else map[key].fail++;
    map[key].buckets[status.bucket] = (map[key].buckets[status.bucket] ?? 0) + 1;
}

function finalizeBucketMap(map) {
    for (const value of Object.values(map)) {
        value.rate = value.total > 0 ? Number((value.pass / value.total).toFixed(4)) : 0;
    }
}

function summarize(results) {
    const summary = {
        total: results.length,
        passCount: 0,
        failCount: 0,
        successRate: 0,
        buckets: {},
        byGroup: {},
        byDecisionTier: {},
        bySource: {},
        byAnchor: {},
        sourceOnly: null
    };

    for (const record of results) {
        const status = record.classification;
        if (status.status === 'pass') summary.passCount++;
        else summary.failCount++;
        summary.buckets[status.bucket] = (summary.buckets[status.bucket] ?? 0) + 1;
        incrementBucket(summary.byGroup, record.group, status);
        incrementBucket(summary.byDecisionTier, record.decisionTier ?? 'null', status);
        incrementBucket(summary.bySource, record.source || 'null', status);
        incrementBucket(summary.byAnchor, anchorKey(record.actualAnchor), status);
    }

    summary.successRate = summary.total > 0
        ? Number((summary.passCount / summary.total).toFixed(4))
        : 0;
    finalizeBucketMap(summary.byGroup);
    finalizeBucketMap(summary.byDecisionTier);
    finalizeBucketMap(summary.bySource);
    finalizeBucketMap(summary.byAnchor);

    const sourceOnly = summary.byGroup['task-source'] ?? null;
    summary.sourceOnly = sourceOnly
        ? {
            total: sourceOnly.total,
            passCount: sourceOnly.pass,
            failCount: sourceOnly.fail,
            successRate: sourceOnly.rate,
            buckets: sourceOnly.buckets
        }
        : null;

    return summary;
}

async function loadBaseline(baselinePath) {
    try {
        return JSON.parse(stripBom(await readFile(baselinePath, 'utf8')));
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return null;
    }
}

function compareToBaseline(results, baseline) {
    if (!baseline?.results) {
        return {
            newlyPassing: [],
            newlyFailing: []
        };
    }

    const previousByName = new Map(baseline.results.map((record) => [
        record.fileName,
        record.classification?.status ?? 'unknown'
    ]));
    const newlyPassing = [];
    const newlyFailing = [];
    for (const record of results) {
        const previousStatus = previousByName.get(record.fileName);
        if (previousStatus === 'fail' && record.classification.status === 'pass') {
            newlyPassing.push(record.fileName);
        } else if (previousStatus === 'pass' && record.classification.status === 'fail') {
            newlyFailing.push(record.fileName);
        }
    }
    return {
        newlyPassing,
        newlyFailing
    };
}

async function benchmarkSample({ sampleRoot, baselinePath, outputPath }) {
    const alphaMaps = resolveAlphaMaps();
    const images = await listImages(sampleRoot);
    const results = [];

    for (const item of images) {
        const imageData = await decodeImageDataInNode(item.filePath);
        const processed = processWatermarkImageData(imageData, alphaMaps);
        const meta = processed.meta;
        const record = {
            fileName: item.fileName,
            filePath: item.filePath,
            group: item.group,
            expectedGemini: true,
            width: imageData.width,
            height: imageData.height,
            applied: meta.applied === true,
            skipReason: meta.skipReason || null,
            source: meta.source || '',
            decisionTier: meta.decisionTier || null,
            actualAnchor: meta.config
                ? {
                    logoSize: meta.config.logoSize,
                    marginRight: meta.config.marginRight,
                    marginBottom: meta.config.marginBottom,
                    ...(meta.config.alphaVariant ? { alphaVariant: meta.config.alphaVariant } : {})
                }
                : null,
            alphaGain: toFiniteNumber(meta.alphaGain),
            position: meta.position ?? null,
            size: meta.size ?? null,
            passCount: meta.passCount ?? 0,
            attemptedPassCount: meta.attemptedPassCount ?? 0,
            passStopReason: meta.passStopReason || null,
            residualScore: roundNumber(meta.detection?.processedSpatialScore),
            processedGradientScore: roundNumber(meta.detection?.processedGradientScore),
            originalSpatialScore: roundNumber(meta.detection?.originalSpatialScore),
            originalGradientScore: roundNumber(meta.detection?.originalGradientScore),
            suppressionGain: roundNumber(meta.detection?.suppressionGain),
            adaptiveConfidence: roundNumber(meta.detection?.adaptiveConfidence),
            residualVisibility: meta.detection?.residualVisibility ?? null
        };
        record.classification = classifyExternalBenchmarkCase(record);
        results.push(record);
    }

    const baseline = await loadBaseline(baselinePath);
    const comparison = compareToBaseline(results, baseline);
    const failures = results
        .filter((record) => record.classification.status === 'fail')
        .map((record) => ({
            fileName: record.fileName,
            group: record.group,
            bucket: record.classification.bucket,
            width: record.width,
            height: record.height,
            applied: record.applied,
            skipReason: record.skipReason,
            decisionTier: record.decisionTier,
            source: record.source,
            anchor: record.actualAnchor,
            alphaGain: record.alphaGain,
            residualScore: record.residualScore,
            processedGradientScore: record.processedGradientScore,
            originalSpatialScore: record.originalSpatialScore,
            originalGradientScore: record.originalGradientScore,
            suppressionGain: record.suppressionGain,
            residualVisibility: record.residualVisibility,
            filePath: record.filePath
        }));

    return {
        generatedAt: new Date().toISOString(),
        sampleRoot,
        outputDir: path.dirname(outputPath ?? DEFAULT_OUTPUT_PATH),
        policy: {
            residualFailThreshold: RESIDUAL_FAIL_THRESHOLD,
            minExpectedSuppressionGain: MIN_EXPECTED_SUPPRESSION_GAIN
        },
        previousSummary: baseline?.summary ?? null,
        summary: summarize(results),
        newlyPassing: comparison.newlyPassing,
        newlyFailing: comparison.newlyFailing,
        failures,
        results
    };
}

function renderMarkdown(report) {
    const lines = [
        '# External Gemini Watermark Sample Benchmark',
        '',
        `- Generated: ${report.generatedAt}`,
        `- Sample root: \`${report.sampleRoot}\``,
        `- Total: ${report.summary.total}`,
        `- Pass: ${report.summary.passCount}/${report.summary.total} (${formatRate(report.summary.passCount, report.summary.total)})`,
        `- Fail: ${report.summary.failCount}`,
        `- Buckets: ${Object.entries(report.summary.buckets).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `- Newly passing vs baseline: ${report.newlyPassing.length}`,
        `- Newly failing vs baseline: ${report.newlyFailing.length}`,
        ''
    ];

    if (report.summary.sourceOnly) {
        lines.push('## Task Source');
        lines.push('');
        lines.push(
            `- Pass: ${report.summary.sourceOnly.passCount}/${report.summary.sourceOnly.total} ` +
            `(${formatRate(report.summary.sourceOnly.passCount, report.summary.sourceOnly.total)})`
        );
        lines.push(`- Fail: ${report.summary.sourceOnly.failCount}`);
        lines.push(`- Buckets: ${Object.entries(report.summary.sourceOnly.buckets).map(([key, value]) => `${key}=${value}`).join(', ')}`);
        lines.push('');
    }

    lines.push('## Failures');
    lines.push('');
    for (const failure of report.failures) {
        lines.push(
            `- ${failure.fileName} | ${failure.bucket} | applied=${failure.applied} | ` +
            `source=${failure.source || 'null'} | anchor=${anchorKey(failure.anchor)} | ` +
            `residual=${failure.residualScore ?? 'null'} | gradient=${failure.processedGradientScore ?? 'null'}`
        );
    }
    lines.push('');

    return `${lines.join('\n')}\n`;
}

function csvCell(value) {
    const text = value == null ? '' : String(value);
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function renderFailuresCsv(failures) {
    const header = [
        'fileName',
        'group',
        'bucket',
        'width',
        'height',
        'applied',
        'source',
        'decisionTier',
        'anchor',
        'alphaGain',
        'residualScore',
        'processedGradientScore',
        'originalSpatialScore',
        'originalGradientScore',
        'suppressionGain'
    ];
    const rows = failures.map((failure) => [
        failure.fileName,
        failure.group,
        failure.bucket,
        failure.width,
        failure.height,
        failure.applied,
        failure.source,
        failure.decisionTier,
        anchorKey(failure.anchor),
        failure.alphaGain,
        failure.residualScore,
        failure.processedGradientScore,
        failure.originalSpatialScore,
        failure.originalGradientScore,
        failure.suppressionGain
    ]);

    return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = await benchmarkSample(args);
    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await mkdir(path.dirname(args.markdownPath), { recursive: true });
    await mkdir(path.dirname(args.failuresCsvPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(args.markdownPath, renderMarkdown(report), 'utf8');
    await writeFile(args.failuresCsvPath, renderFailuresCsv(report.failures), 'utf8');

    console.log(`summary: pass=${report.summary.passCount} fail=${report.summary.failCount} total=${report.summary.total}`);
    console.log(`newlyPassing=${report.newlyPassing.length} newlyFailing=${report.newlyFailing.length}`);
    console.log(`report: ${args.outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
