# Same Anchor Clean Dominance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当相同 `x/y/width/height` 的 clean 候选在 evidence、residual、damage 三项 loss 上严格支配当前非 clean 候选时，让它越过 discovery penalty 成为 top-1。

**Architecture:** 在 `pipelineCandidateQuality.js` 的最终比较器中增加一个位于 catastrophic block 之后、现有 dominated/final score 之前的同 anchor clean 严格支配比较。候选生成、质量测量、discovery penalty 数值、top-N 元数据和图片处理链路保持不变；定点验证脚本只在 `.artifacts` 中保存 6 张前后输出与裁剪。

**Tech Stack:** JavaScript ES modules、Node.js `node:test`、pnpm、Sharp、本地 424 张近期图片样本。

## Global Constraints

- clean 覆盖只适用于结构化 `position.x/y/width/height` 完全相同的候选。
- clean 候选的 `evidenceLoss`、`residualLoss`、`damageLoss` 均不得更高，且至少一项严格更低。
- catastrophic block 始终高于 clean 覆盖。
- 两个候选都 clean、都非 clean、anchor 不同或 loss 存在取舍时，继续使用现有 discovery penalty、dominated、final score 和 ranking key。
- 不修改 `0.35/0.40/0.25` 三项权重、`0.15` conservative-derived penalty、候选生成数量、family、修复算法或瑕疵反馈。
- 预期 top-1 变化范围为静态模拟识别的 6/424；超过 6 时暂停排查，不扩大规则。
- 只提交 `src/core/pipelineCandidateQuality.js` 与 `tests/core/pipelineCandidateQuality.test.js`；保留其他工作区改动。
- 定点视觉验收发现粗粒度 `qualityStatus` 会把残影类型转换误报为完全 clean；排序实现必须同时输出不参与跳过/重试决策的连续 `imperfections` 信号。

---

### Task 1: 建立 6 张样本的修改前视觉基线

**Files:**
- Create: `.artifacts/same-anchor-clean-dominance/run-targeted-validation.mjs`
- Generated: `.artifacts/same-anchor-clean-dominance/before/report.json`
- Generated: `.artifacts/same-anchor-clean-dominance/before/*.png`

**Interfaces:**
- Consumes: 当前 `removeWatermarkFromImageDataSync(imageData, { adaptiveMode: 'auto', debugTimings: true })` 和近期标准样本目录。
- Produces: 每张样本的完整输出、围绕选中位置的裁剪和 compact JSON 指标，供 Task 3 对比。

- [ ] **Step 1: 创建可重复的定点验证脚本**

脚本固定以下 6 个 basename：

```js
const TARGETS = [
    'pilio_2077239087386857472_2077239068982251520_source.png',
    'pilio_2077284098002391040_2077284062476636160_source.png',
    'pilio_2077249894908694528_2077249885823832064_source.png',
    'pilio_2077270440186744832_2077270430879584256_source.png',
    'pilio_2077285331933073408_2077285322655272960_source.jpg',
    'pilio_2077300955929382912_2077300943841398784_source.jpg'
];
```

实现以下完整处理流程：

```js
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { removeWatermarkFromImageDataSync } from '../../src/sdk/image-data.js';

const label = process.argv[2];
const sampleRoot = process.env.GWR_SAMPLE_ROOT;
if (!['before', 'after'].includes(label)) throw new Error('Expected label: before or after');
if (!sampleRoot) throw new Error('GWR_SAMPLE_ROOT is required');

const sourceRoot = path.resolve(sampleRoot, 'RemoveGeminiWatermark', '2026-07-15');
const outputRoot = path.resolve('.artifacts/same-anchor-clean-dominance', label);
await mkdir(outputRoot, { recursive: true });

async function decode(filePath) {
    const { data, info } = await sharp(filePath).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

async function encode(filePath, imageData) {
    await sharp(Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength), {
        raw: { width: imageData.width, height: imageData.height, channels: 4 }
    }).png().toFile(filePath);
}

const records = [];
for (const filename of TARGETS) {
    const input = path.join(sourceRoot, filename);
    const imageData = await decode(input);
    const result = removeWatermarkFromImageDataSync(imageData, {
        adaptiveMode: 'auto',
        debugTimings: true
    });
    const stem = path.parse(filename).name;
    const output = path.join(outputRoot, `${stem}.png`);
    await encode(output, result.imageData);

    const position = result.meta?.selectedCandidate?.position;
    const padding = 24;
    const crop = position ? {
        left: Math.max(0, position.x - padding),
        top: Math.max(0, position.y - padding),
        width: Math.min(imageData.width - Math.max(0, position.x - padding), position.width + padding * 2),
        height: Math.min(imageData.height - Math.max(0, position.y - padding), position.height + padding * 2)
    } : null;
    const cropOutput = crop ? path.join(outputRoot, `${stem}-crop.png`) : null;
    if (crop) await sharp(output).extract(crop).png().toFile(cropOutput);

    const signals = result.meta?.qualitySignals;
    records.push({
        filename,
        input,
        output,
        cropOutput,
        selectedCandidate: result.meta?.selectedCandidate ?? null,
        qualityStatus: result.meta?.qualityStatus ?? null,
        losses: signals ? {
            evidence: signals.evidenceLoss,
            residual: signals.residualLoss,
            damage: signals.damageLoss
        } : null,
        final: signals?.final ?? null,
        artifacts: signals?.artifacts ?? null,
        processingMs: result.debugTimings?.totalMs ?? null
    });
}

await writeFile(
    path.join(outputRoot, 'report.json'),
    `${JSON.stringify({ label, count: records.length, records }, null, 2)}\n`
);
```

- [ ] **Step 2: 运行修改前基线**

Run:

```powershell
if (-not $env:GWR_SAMPLE_ROOT) { throw 'GWR_SAMPLE_ROOT is required' }
node .artifacts/same-anchor-clean-dominance/run-targeted-validation.mjs before
```

Expected: `before/report.json` 包含 6 条记录，每张都有完整输出与 `-crop.png`；当前状态为 5 个 visible residual、1 个 possible content damage。

- [ ] **Step 3: 保存当前 424 报告快照**

Run:

```powershell
Copy-Item -LiteralPath '.artifacts/expanded-sample-validation/curated-top-n/combined-report.json' -Destination '.artifacts/same-anchor-clean-dominance/before-424-report.json' -Force
```

Expected: 快照的 `summary.count = 424`，作为 Task 4 精确比较 top-1 变化的基线。`.artifacts` 文件不加入 Git。

### Task 2: 以 TDD 实现同 Anchor Clean 严格支配比较

**Files:**
- Modify: `src/core/pipelineCandidateQuality.js`
- Test: `tests/core/pipelineCandidateQuality.test.js`

**Interfaces:**
- Consumes: ranked item 的 `hypothesis.trial.position ?? hypothesis.position` 与 `qualitySignals`。
- Produces: 私有 `shouldPreferSameAnchorCleanCandidate(left, right): boolean`，由 `compareRankedCandidates(left, right)` 在 catastrophic block 之后调用。

- [ ] **Step 1: 扩展测试构造器以提供结构化 anchor 与 discovery role**

在 `tests/core/pipelineCandidateQuality.test.js` 增加：

```js
function createCompletedAt(id, qualitySignals, {
    position = { x: 10, y: 20, width: 48, height: 48 },
    discoveryRole = 'fixed-selected'
} = {}) {
    const completed = createCompleted(id, qualitySignals);
    return {
        ...completed,
        hypothesis: {
            ...completed.hypothesis,
            discoveryRole,
            trial: {
                ...completed.hypothesis.trial,
                position
            }
        }
    };
}
```

- [ ] **Step 2: 写出 visible/damage 到 clean 的失败测试**

```js
test('rankCompletedCandidates should prefer a same-anchor clean candidate that strictly dominates visible residual', () => {
    const ranked = rankCompletedCandidates([
        createCompletedAt('fixed-visible', {
            evidenceLoss: 0.1,
            residualLoss: 0.3,
            damageLoss: 0.2,
            residualVisible: true,
            damageWarning: false,
            qualityStatus: 'visible-residual'
        }),
        createCompletedAt('derived-clean', {
            evidenceLoss: 0.1,
            residualLoss: 0.2,
            damageLoss: 0.2,
            residualVisible: false,
            damageWarning: false,
            qualityStatus: 'clean'
        }, { discoveryRole: 'conservative-derived' })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'derived-clean');
});

test('rankCompletedCandidates should prefer a same-anchor clean candidate that strictly dominates damage', () => {
    const ranked = rankCompletedCandidates([
        createCompletedAt('fixed-damage', {
            evidenceLoss: 0.1,
            residualLoss: 0.2,
            damageLoss: 0.4,
            residualVisible: false,
            damageWarning: true,
            qualityStatus: 'possible-content-damage'
        }),
        createCompletedAt('derived-clean', {
            evidenceLoss: 0.1,
            residualLoss: 0.15,
            damageLoss: 0.3,
            residualVisible: false,
            damageWarning: false,
            qualityStatus: 'clean'
        }, { discoveryRole: 'conservative-derived' })
    ]);

    assert.equal(ranked[0].hypothesis.id, 'derived-clean');
});
```

- [ ] **Step 3: 写出不应触发覆盖的边界测试**

增加独立测试覆盖：

```js
test('rankCompletedCandidates should keep discovery priority when both same-anchor candidates are clean', () => {
    const fixed = createCompletedAt('fixed-clean', {
        evidenceLoss: 0.2,
        residualLoss: 0.2,
        damageLoss: 0.2,
        residualVisible: false,
        damageWarning: false,
        qualityStatus: 'clean'
    });
    const derived = createCompletedAt('derived-clean', {
        evidenceLoss: 0.2,
        residualLoss: 0.1,
        damageLoss: 0.2,
        residualVisible: false,
        damageWarning: false,
        qualityStatus: 'clean'
    }, { discoveryRole: 'conservative-derived' });

    assert.equal(rankCompletedCandidates([fixed, derived])[0].hypothesis.id, 'fixed-clean');
});
```

```js
test('rankCompletedCandidates should not override discovery priority across anchors', () => {
    const fixed = createCompletedAt('fixed-visible', {
        evidenceLoss: 0.1,
        residualLoss: 0.3,
        damageLoss: 0.2,
        residualVisible: true,
        damageWarning: false,
        qualityStatus: 'visible-residual'
    });
    const derived = createCompletedAt('derived-clean', {
        evidenceLoss: 0.1,
        residualLoss: 0.2,
        damageLoss: 0.2,
        residualVisible: false,
        damageWarning: false,
        qualityStatus: 'clean'
    }, {
        discoveryRole: 'conservative-derived',
        position: { x: 11, y: 20, width: 48, height: 48 }
    });

    assert.equal(rankCompletedCandidates([fixed, derived])[0].hypothesis.id, 'fixed-visible');
});
```

增加 loss 存在取舍的用例：

```js
test('rankCompletedCandidates should not apply clean dominance when one loss is worse', () => {
    const fixed = createCompletedAt('fixed-visible', {
        evidenceLoss: 0.1,
        residualLoss: 0.3,
        damageLoss: 0.2,
        residualVisible: true,
        damageWarning: false,
        qualityStatus: 'visible-residual'
    });
    const derived = createCompletedAt('derived-clean', {
        evidenceLoss: 0.1,
        residualLoss: 0.2,
        damageLoss: 0.21,
        residualVisible: false,
        damageWarning: false,
        qualityStatus: 'clean'
    }, { discoveryRole: 'conservative-derived' });

    assert.equal(rankCompletedCandidates([fixed, derived])[0].hypothesis.id, 'fixed-visible');
});
```

增加 catastrophic block 高于 clean 覆盖的用例：

```js
test('rankCompletedCandidates should keep catastrophic block above same-anchor clean dominance', () => {
    const catastrophic = createCompletedAt('catastrophic-clean', {
        evidenceLoss: 0,
        residualLoss: 0,
        damageLoss: 0,
        residualVisible: false,
        damageWarning: false,
        qualityStatus: 'clean',
        damageComponents: { nearBlack: 1, nearWhite: 0, clipped: 1 },
        texture: { hardReject: true }
    }, { discoveryRole: 'conservative-derived' });
    const ordinary = createCompletedAt('ordinary-visible', {
        evidenceLoss: 0.1,
        residualLoss: 0.3,
        damageLoss: 0.2,
        residualVisible: true,
        damageWarning: false,
        qualityStatus: 'visible-residual',
        damageComponents: { nearBlack: 0, nearWhite: 0, clipped: 0 },
        texture: { hardReject: false }
    });

    assert.equal(rankCompletedCandidates([catastrophic, ordinary])[0].hypothesis.id, 'ordinary-visible');
});
```

- [ ] **Step 4: 运行测试并确认 RED 原因正确**

Run:

```powershell
node --test tests/core/pipelineCandidateQuality.test.js
```

Expected: 新增的 visible/damage clean 严格支配测试失败，当前 fixed candidate 因 discovery penalty 仍排第一；既有测试继续通过。

- [ ] **Step 5: 实现结构化 anchor 与严格支配 helper**

在 `src/core/pipelineCandidateQuality.js` 增加：

```js
function getCandidatePosition(candidate = {}) {
    return candidate.hypothesis?.trial?.position ?? candidate.hypothesis?.position ?? null;
}

function hasSameCandidateAnchor(left, right) {
    const leftPosition = getCandidatePosition(left);
    const rightPosition = getCandidatePosition(right);
    if (!leftPosition || !rightPosition) return false;
    return leftPosition.x === rightPosition.x &&
        leftPosition.y === rightPosition.y &&
        leftPosition.width === rightPosition.width &&
        leftPosition.height === rightPosition.height;
}

function strictlyDominatesQuality(leftSignals = {}, rightSignals = {}) {
    const keys = ['evidenceLoss', 'residualLoss', 'damageLoss'];
    const noWorse = keys.every((key) => (
        (leftSignals[key] ?? Infinity) <= (rightSignals[key] ?? Infinity)
    ));
    const strictlyBetter = keys.some((key) => (
        (leftSignals[key] ?? Infinity) < (rightSignals[key] ?? Infinity)
    ));
    return noWorse && strictlyBetter;
}

function shouldPreferSameAnchorCleanCandidate(left, right) {
    return left.qualitySignals?.qualityStatus === 'clean' &&
        right.qualitySignals?.qualityStatus !== 'clean' &&
        hasSameCandidateAnchor(left, right) &&
        strictlyDominatesQuality(left.qualitySignals, right.qualitySignals);
}
```

- [ ] **Step 6: 在 catastrophic block 之后应用对称比较**

修改 `compareRankedCandidates`：

```js
const leftCatastrophic = hasCatastrophicBlock(left.qualitySignals);
const rightCatastrophic = hasCatastrophicBlock(right.qualitySignals);
if (leftCatastrophic !== rightCatastrophic) return leftCatastrophic ? 1 : -1;

const leftCleanDominates = shouldPreferSameAnchorCleanCandidate(left, right);
const rightCleanDominates = shouldPreferSameAnchorCleanCandidate(right, left);
if (leftCleanDominates !== rightCleanDominates) return leftCleanDominates ? -1 : 1;

if (left.dominated !== right.dominated) return left.dominated ? 1 : -1;
```

其余 final score、ranking key、ID 逻辑不变。

- [ ] **Step 7: 运行聚焦测试并确认 GREEN**

Run:

```powershell
node --test tests/core/pipelineCandidateQuality.test.js tests/core/imageWatermarkPipeline.test.js tests/core/pipelineMeta.test.js tests/core/pipelineResult.test.js
git diff --check -- src/core/pipelineCandidateQuality.js tests/core/pipelineCandidateQuality.test.js
```

Expected: 所有测试通过；无空白错误。

- [ ] **Step 8: 提交排序实现与测试**

```powershell
git add -- src/core/pipelineCandidateQuality.js tests/core/pipelineCandidateQuality.test.js
git commit -m "fix: prefer clean same-anchor candidates"
```

### Task 3: 对 6 张目标样本做输出与视觉核验

**Files:**
- Generated: `.artifacts/same-anchor-clean-dominance/after/report.json`
- Generated: `.artifacts/same-anchor-clean-dominance/after/*.png`
- Compare: `.artifacts/same-anchor-clean-dominance/before/*.png`

**Interfaces:**
- Consumes: Task 1 的验证脚本与 Task 2 的新排序。
- Produces: 6 张实际处理输出、裁剪图和候选/质量变化记录。

- [ ] **Step 1: 运行修改后定点验证**

Run:

```powershell
if (-not $env:GWR_SAMPLE_ROOT) { throw 'GWR_SAMPLE_ROOT is required' }
node .artifacts/same-anchor-clean-dominance/run-targeted-validation.mjs after
```

Expected: 6 张都选择相同 anchor 的 clean 候选；位置和尺寸保持不变。

- [ ] **Step 2: 比较修改前后 JSON**

Run:

```powershell
node -e "const fs=require('fs');const b=JSON.parse(fs.readFileSync('.artifacts/same-anchor-clean-dominance/before/report.json'));const a=JSON.parse(fs.readFileSync('.artifacts/same-anchor-clean-dominance/after/report.json'));console.log(a.records.map((x,i)=>({file:x.filename,before:b.records[i].qualityStatus,after:x.qualityStatus,beforeLoss:b.records[i].losses,afterLoss:x.losses,beforeCandidate:b.records[i].selectedCandidate?.id,afterCandidate:x.selectedCandidate?.id})))"
```

Expected: 5 个 visible residual 与 1 个 possible content damage 变为 clean，三项 loss 不增加，anchor 不变。

- [ ] **Step 3: 肉眼核验 6 组裁剪**

用本地图片查看工具逐组查看 `before/*-crop.png` 和 `after/*-crop.png`。每张必须满足：水印残留更弱或相当；没有新增黑洞、白块、模糊边缘或内容结构损伤。任一张视觉退化则停止，不进入全量回归，并回到排序条件分析。

- [ ] **Step 4: 验证底层瑕疵信号不再把残影转换隐藏为完全无瑕疵**

在 `qualitySignals.imperfections` 暴露 spatial、gradient、positive-halo 的原始值、阈值与比率，并输出 `score/severity/types/detected`。该信号不得改变是否处理、retry 或 fail-closed；定点样本中仍有肉眼残影的候选至少应为 `moderate`，而不是只能依赖粗粒度 `qualityStatus`。

### Task 4: 验证 36/424 样本边界与完整工程回归

**Files:**
- Generated: `.artifacts/top-n-candidate-selection/contrast-report.json`
- Generated: `.artifacts/expanded-sample-validation/curated-top-n/combined-report.json`
- Compare: `.artifacts/same-anchor-clean-dominance/before-424-report.json`

**Interfaces:**
- Consumes: 已通过视觉核验的排序实现。
- Produces: top-1 变化范围、质量桶、错误/灾难性块、自动测试和构建证据。

- [ ] **Step 1: 运行 36 样本对照集**

Run:

```powershell
node .artifacts/top-n-candidate-selection/run-contrast-validation.mjs
```

Expected: catastrophic blocks `0`、retry `0`、recovered clean 至少 `15/16`；不出现原 clean 样本退化。

- [ ] **Step 2: 并行重跑当前 424 样本**

Run two shards with the standard sample root:

```powershell
node .artifacts/expanded-sample-validation/run-expanded-image-validation.mjs --source "$env:GWR_SAMPLE_ROOT/RemoveGeminiWatermark/2026-07-15" --all-images --shard-count 2 --sample-order path --no-resume --shard-index 0 --out-dir .artifacts/expanded-sample-validation/curated-top-n/shard-0
```

```powershell
node .artifacts/expanded-sample-validation/run-expanded-image-validation.mjs --source "$env:GWR_SAMPLE_ROOT/RemoveGeminiWatermark/2026-07-15" --all-images --shard-count 2 --sample-order path --no-resume --shard-index 1 --out-dir .artifacts/expanded-sample-validation/curated-top-n/shard-1
```

Then summarize:

```powershell
node .artifacts/expanded-sample-validation/summarize-curated-validation.mjs --root .artifacts/expanded-sample-validation/curated-top-n
```

Expected: errors `0`、catastrophic blocks `0`、retry `0`；top-1 变化不超过 6/424；预期质量净变化为 clean `+6`、visible residual `-5`、possible content damage `-1`，原 clean 样本不得退化。

- [ ] **Step 3: 精确比较 before/after top-1**

使用 basename 连接两个 report，比较 `selectedCandidate.id`、anchor 和 `qualityStatus`。输出 changed 列表并断言：

```js
changed.length <= 6;
changed.every((item) => item.beforeAnchor === item.afterAnchor);
changed.every((item) => item.beforeStatus !== 'clean');
changed.every((item) => item.afterStatus === 'clean');
```

若当前 report 未持久化 selected candidate ID，则用 family、source、position、alpha gain 的组合作为 top-1 identity，并单独核对 6 张定点报告。

- [ ] **Step 4: 运行全量测试、生产构建和最终差异检查**

Run:

```powershell
pnpm test
pnpm build
git diff --check
```

Expected: 全量测试 0 fail；生产构建成功；差异检查无错误。本次实现提交只包含两个实现/测试文件，`.artifacts` 不进入 Git。
