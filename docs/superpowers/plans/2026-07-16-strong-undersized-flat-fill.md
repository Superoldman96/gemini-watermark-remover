# Strong Undersized Flat-Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让具备完整 provenance 的 38–42px strong undersized adaptive 候选以 `0.27` 进入现有 flat-fill，同时保持所有普通 known-48 路径的 `0.28` 入口与后续质量门不变。

**Architecture:** 在清理资格层生成显式的 `useStrongUndersizedAdaptiveCleanup` 标记，经 runtime bootstrap 和 accepted executor 传入 repair stage specs。stage specs 根据该标记选择基线梯度入口阈值，并把数值传给现有 refiner；refiner 只把硬编码入口改为可配置参数，不改 preset、候选排序或验收条件。

**Tech Stack:** JavaScript ES modules、Node.js `node:test`、pnpm、Sharp、本地样本验证脚本。

## Global Constraints

- 仅完整满足 `adaptive === true`、`strongUndersizedMatch === true`、宽度 `38..42px`、source 以 `adaptive` 开头且非 preview-anchor 的路径使用 `0.27`。
- 普通 known-48、catalog、standard 和 preview-anchor 路径继续使用 `0.28`。
- 保留现有 flat-fill 空间、梯度、背景平坦度、halo 和损伤验收门。
- 不改变定位、alpha 模板、增益、清理顺序、flat-fill preset 强度或瑕疵反馈契约。
- 不新增填充、模糊或 inpaint 算法，不把 82px 边距加入 catalog。
- 只暂存并提交本计划列出的文件，保留工作区中其他既有改动。

---

### Task 1: 形成并传播强小尺寸清理资格标记

**Files:**
- Modify: `src/core/pipelineRepairGates.js`
- Test: `tests/core/pipelineRepairGates.test.js`
- Test: `tests/core/pipelineRuntimeBootstrap.test.js`

**Interfaces:**
- Consumes: `selectedTrial.provenance`、最终 `position.width` 和当前 `source`。
- Produces: `shouldUseStrongUndersizedAdaptiveCleanup({ selectedTrial, position, source }): boolean`；`createRepairCleanupFlags()` 新增 `useStrongUndersizedAdaptiveCleanup: boolean`。

- [ ] **Step 1: 写出失败的资格判定测试**

在 `tests/core/pipelineRepairGates.test.js` 导入新 helper，并增加完整正反例：

```js
test('strong undersized cleanup gate should require complete adaptive provenance', () => {
    const selectedTrial = {
        config: { logoSize: 40, marginRight: 82, marginBottom: 82 },
        provenance: { adaptive: true, strongUndersizedMatch: true }
    };

    assert.equal(shouldUseStrongUndersizedAdaptiveCleanup({
        selectedTrial,
        position: { width: 40 },
        source: 'adaptive+gain+fine-alpha'
    }), true);

    for (const rejected of [
        { selectedTrial: { ...selectedTrial, provenance: { adaptive: true } }, position: { width: 40 }, source: 'adaptive' },
        { selectedTrial: { ...selectedTrial, provenance: { strongUndersizedMatch: true } }, position: { width: 40 }, source: 'adaptive' },
        { selectedTrial: { ...selectedTrial, provenance: { ...selectedTrial.provenance, previewAnchor: true } }, position: { width: 40 }, source: 'adaptive' },
        { selectedTrial, position: { width: 37 }, source: 'adaptive' },
        { selectedTrial, position: { width: 43 }, source: 'adaptive' },
        { selectedTrial, position: { width: 40 }, source: 'standard' }
    ]) {
        assert.equal(shouldUseStrongUndersizedAdaptiveCleanup(rejected), false);
    }
});
```

扩充 `createRepairCleanupFlags` 断言，使普通 48px 结果包含 `useStrongUndersizedAdaptiveCleanup: false`，并增加 40px adaptive 结果为 `true`。在 `tests/core/pipelineRuntimeBootstrap.test.js` 的现有 preview-anchor 断言中增加该标记为 `false`。

- [ ] **Step 2: 运行测试，确认因缺少 helper/flag 失败**

Run:

```powershell
node --test tests/core/pipelineRepairGates.test.js tests/core/pipelineRuntimeBootstrap.test.js
```

Expected: FAIL，错误指出 `shouldUseStrongUndersizedAdaptiveCleanup` 未导出或聚合结果缺少新属性。

- [ ] **Step 3: 实现单一资格 helper 并复用它**

在 `src/core/pipelineRepairGates.js` 增加：

```js
export function shouldUseStrongUndersizedAdaptiveCleanup({
    selectedTrial,
    position,
    source
} = {}) {
    if (selectedTrial?.provenance?.previewAnchor === true) return false;
    const sourceText = String(source || '');
    return selectedTrial?.provenance?.adaptive === true &&
        selectedTrial?.provenance?.strongUndersizedMatch === true &&
        position?.width >= 38 &&
        position?.width <= 42 &&
        sourceText.startsWith('adaptive');
}
```

`shouldUseKnown48EdgeCleanup()` 调用该 helper，删除现有重复内联条件；`createRepairCleanupFlags()` 也显式返回该标记：

```js
return {
    usePreviewAnchorFastCleanup: shouldUsePreviewAnchorFastCleanup(/* existing args */),
    useKnown48EdgeCleanup: shouldUseKnown48EdgeCleanup(/* existing args */),
    useStrongUndersizedAdaptiveCleanup: shouldUseStrongUndersizedAdaptiveCleanup({
        selectedTrial,
        position,
        source
    }),
    useV2SmallEdgeCleanup: shouldUseV2SmallEdgeCleanup(/* existing args */)
};
```

- [ ] **Step 4: 运行测试，确认资格与 bootstrap 合约通过**

Run:

```powershell
node --test tests/core/pipelineRepairGates.test.js tests/core/pipelineRuntimeBootstrap.test.js
```

Expected: PASS，所有新增正反例及既有 gate 测试通过。

- [ ] **Step 5: 提交资格标记改动**

```powershell
git add -- src/core/pipelineRepairGates.js tests/core/pipelineRepairGates.test.js tests/core/pipelineRuntimeBootstrap.test.js
git commit -m "fix: expose strong undersized cleanup flag"
```

### Task 2: 将路径专属入口阈值传入现有 flat-fill refiner

**Files:**
- Modify: `src/core/pipelineAcceptedExecutor.js`
- Modify: `src/core/pipelineRepairStageSpecs.js`
- Modify: `src/core/watermarkProcessor.js`
- Test: `tests/core/pipelineAcceptedExecutor.test.js`
- Test: `tests/core/pipelineRepairStageSpecs.test.js`

**Interfaces:**
- Consumes: Task 1 产生的 `cleanupFlags.useStrongUndersizedAdaptiveCleanup`。
- Produces: `createRepairCleanupPhaseSpecs()` 向 refiner 传递 `minBaselineGradient: number`；`refineKnown48FlatBackgroundResidual()` 接受该参数，默认仍为 `0.28`。

- [ ] **Step 1: 写出失败的阈值选择测试**

在 `tests/core/pipelineRepairStageSpecs.test.js` 增加：

```js
test('known 48 flat fill should lower only the strong undersized entry threshold', () => {
    for (const [useStrongUndersizedAdaptiveCleanup, expected] of [[false, 0.28], [true, 0.27]]) {
        let received = null;
        const specs = createRepairCleanupPhaseSpecs({
            readState: () => ({
                finalImageData: { id: 'image' },
                alphaMap: 'alpha',
                position: { x: 1, y: 2, width: 40, height: 40 },
                finalProcessedSpatialScore: 0.12,
                finalProcessedGradientScore: 0.277,
                source: 'adaptive+edge-cleanup'
            }),
            useKnown48EdgeCleanup: true,
            useStrongUndersizedAdaptiveCleanup,
            cleanupConfig: {
                known48FlatFillMinGradient: 0.28,
                strongUndersizedFlatFillMinGradient: 0.27
            },
            refiners: {
                refineKnown48FlatBackgroundResidual: (payload) => {
                    received = payload.minBaselineGradient;
                    return null;
                }
            }
        });

        specs.known48FlatFill.createStage(0);
        assert.equal(received, expected);
    }
});
```

同时在 `tests/core/pipelineAcceptedExecutor.test.js` 的 mock cleanup flags 中显式加入 `useStrongUndersizedAdaptiveCleanup: false`，固定对象合约。

- [ ] **Step 2: 运行测试，确认专属阈值尚未传递**

Run:

```powershell
node --test tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineAcceptedExecutor.test.js
```

Expected: FAIL，`received` 为 `undefined` 或两个分支未分别得到 `0.28`/`0.27`。

- [ ] **Step 3: 在 executor 与 stage specs 中传递标记和数值**

在 `src/core/pipelineAcceptedExecutor.js` 从 cleanup flags 解构并传给 `createRepairCleanupPhaseSpecs()`：

```js
const {
    usePreviewAnchorFastCleanup,
    useKnown48EdgeCleanup,
    useStrongUndersizedAdaptiveCleanup,
    useV2SmallEdgeCleanup
} = cleanupFlags;
```

在 `src/core/pipelineRepairStageSpecs.js` 增加参数和配置项：

```js
useStrongUndersizedAdaptiveCleanup = false,
```

```js
known48FlatFillMinGradient = 0.28,
strongUndersizedFlatFillMinGradient = 0.27,
```

flat-fill payload 增加：

```js
minBaselineGradient: useStrongUndersizedAdaptiveCleanup
    ? strongUndersizedFlatFillMinGradient
    : known48FlatFillMinGradient,
```

- [ ] **Step 4: 参数化 refiner 的入口门槛并配置两个常量**

在 `src/core/watermarkProcessor.js` 保留默认常量并新增专属常量：

```js
const KNOWN_48_FLAT_FILL_MIN_GRADIENT = 0.28;
const STRONG_UNDERSIZED_FLAT_FILL_MIN_GRADIENT = 0.27;
```

修改 refiner 参数与 guard：

```js
function refineKnown48FlatBackgroundResidual({
    sourceImageData,
    alphaMap,
    position,
    baselineSpatialScore,
    baselineGradientScore,
    minBaselineGradient = KNOWN_48_FLAT_FILL_MIN_GRADIENT,
    minGradientImprovement = KNOWN_48_FLAT_FILL_MIN_GRADIENT_IMPROVEMENT
}) {
    if (
        position?.width < KNOWN_48_EDGE_CLEANUP_MIN_SIZE ||
        position?.width > KNOWN_48_EDGE_CLEANUP_MAX_SIZE ||
        baselineGradientScore < minBaselineGradient
    ) {
        return null;
    }
```

`createAcceptedPipelineExecutorConfig().repairCleanupConfig` 增加：

```js
known48FlatFillMinGradient: KNOWN_48_FLAT_FILL_MIN_GRADIENT,
strongUndersizedFlatFillMinGradient: STRONG_UNDERSIZED_FLAT_FILL_MIN_GRADIENT,
```

- [ ] **Step 5: 运行聚焦测试并做静态差异检查**

Run:

```powershell
node --test tests/core/pipelineRepairGates.test.js tests/core/pipelineRuntimeBootstrap.test.js tests/core/pipelineRepairStageSpecs.test.js tests/core/pipelineAcceptedExecutor.test.js
git diff --check
```

Expected: 全部 PASS；`git diff --check` 无输出且退出码为 0。

- [ ] **Step 6: 提交阈值传递改动**

```powershell
git add -- src/core/pipelineAcceptedExecutor.js src/core/pipelineRepairStageSpecs.js src/core/watermarkProcessor.js tests/core/pipelineAcceptedExecutor.test.js tests/core/pipelineRepairStageSpecs.test.js
git commit -m "fix: lower flat fill gate for strong undersized matches"
```

### Task 3: 验证 severe-10 改善并守住扩大样本基线

**Files:**
- Generated: `.artifacts/top-n-candidate-selection/contrast-report.json`
- Generated: `.artifacts/top-n-candidate-selection/selected/severe-10.png`
- Generated: `.artifacts/expanded-sample-validation/curated-top-n/combined-report.json`
- Verify only: source and test files from Tasks 1–2

**Interfaces:**
- Consumes: Tasks 1–2 的完整执行链路。
- Produces: 定点指标、36 样本结果、419 样本结果、全量测试和生产构建证据。

- [ ] **Step 1: 运行 severe-10 定点验证**

Run:

```powershell
$env:GWR_CONTRAST_IDS='severe-10'
node .artifacts/top-n-candidate-selection/run-contrast-validation.mjs
Remove-Item Env:GWR_CONTRAST_IDS
```

Expected:

- selected candidate 保持 `40x40 @ (611,902)`；
- source 包含 `flat-fill`；
- final gradient `< 0.277`；
- halo `< 0.83`；
- artifact cost `< 0.309`；
- 输出更新为 `.artifacts/top-n-candidate-selection/selected/severe-10.png`。

- [ ] **Step 2: 运行 36 样本对照集**

Run:

```powershell
node .artifacts/top-n-candidate-selection/run-contrast-validation.mjs
```

Expected: `clean=19`、干净恢复 `15/16`、`catastrophicBlocks=0`、retry 推荐为 0。

- [ ] **Step 3: 并行运行 419 样本两分片并汇总**

分别运行：

```powershell
node .artifacts/expanded-sample-validation/run-expanded-image-validation.mjs --source D:/Project/sample-files/gemini-watermark/2026-07-15 --all-images --shard-count 2 --sample-order path --no-resume --shard-index 0 --out-dir .artifacts/expanded-sample-validation/curated-top-n/shard-0
```

```powershell
node .artifacts/expanded-sample-validation/run-expanded-image-validation.mjs --source D:/Project/sample-files/gemini-watermark/2026-07-15 --all-images --shard-count 2 --sample-order path --no-resume --shard-index 1 --out-dir .artifacts/expanded-sample-validation/curated-top-n/shard-1
```

然后汇总：

```powershell
node .artifacts/expanded-sample-validation/summarize-curated-validation.mjs --root .artifacts/expanded-sample-validation/curated-top-n
```

Expected: `304 applied-clean / 115 residual-risk`、retry `0`、errors `0`、catastrophic blocks `0`；质量分布不低于 `clean=311` 的既有基线。

- [ ] **Step 4: 运行全量测试、生产构建和最终差异检查**

Run:

```powershell
pnpm test
pnpm build
git diff --check
```

Expected: 测试零失败（既有基线约 1318 total / 1290 pass / 28 skip）、构建成功、差异检查无错误。

- [ ] **Step 5: 核对提交范围并报告结果**

Run:

```powershell
git status --short
git log -3 --oneline
```

Expected: 两个实现提交只包含计划列出的源文件/测试；生成产物和用户既有工作区改动不进入提交。最终报告 severe-10 前后指标、36/419 汇总、全量测试与输出样例绝对路径。
