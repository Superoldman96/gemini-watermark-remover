# pilio-frontend 与 gemini-watermark-remover 运行时同步方案

更新时间：2026-04-16

## 0. 当前实现状态

截至本轮改造，仓库内已落地：

- 稳定公共子路径：
  - `@pilio/gemini-watermark-remover/runtime-browser`
- experimental 子路径：
  - `@pilio/gemini-watermark-remover/runtime-userscript`
- 对应实现与类型入口：
  - `src/runtime/browser.js`
  - `src/runtime/browser.d.ts`
  - `src/runtime/userscript.js`
  - `src/runtime/userscript.d.ts`
- package-consumer 级验证：
  - `pnpm pack` 后隔离 consumer 可直接导入新子路径
  - TypeScript consumer 可编译通过
  - 深层私有导入 `@pilio/gemini-watermark-remover/src/...` 被显式拒绝

当前边界已经明确：

- `runtime-browser`
  - 是纯处理入口
  - 只负责 `Blob -> processedBlob/processedMeta`
  - 导入和构造时不触碰 `window`
  - 不安装 page bridge，不携带 DOM / MutationObserver / Gemini 页面副作用
- `runtime-userscript`
  - 只暴露窄处理接口
  - 保留 worker 初始化与 main-thread fallback
  - 不等于整个 userscript bootstrap
- `src/page/pageProcessRuntime.js`
  - 继续作为内部 page adapter
  - 不作为公共 runtime 导出
- `src/shared/pageImageReplacement.js`
  - 继续是页面集成层
  - 不进入 `runtime-browser` 公共 API

## 1. 问题背景

当前现象是：

- 同一张图 `debug1.png`
- 在 `D:\Project\gemini-watermark-remover` 跑通
- 在 `pilio-frontend` 的当前链路里，用户观感上认为“没有去掉”
- `https://gemini.pilio.ai/` 的开发者预览效果更接近预期

这说明问题不能只看“单个核心算法文件”，而要看整条运行时链路。

## 2. 已验证结论

这次排查里已经确认了几个关键事实。

### 2.1 `debug1.png` 的本地核心输出一致

针对同一输入图：

- `pilio-frontend` 本地 Gemini 去水印核心输出
- `gemini-watermark-remover` 的 Node SDK 输出

生成结果逐字节一致，`diffBytes = 0`，SHA256 一致。

已生成的对比文件：

- `D:\Project\pilio\pilio-frontend\test-output\gemini-open-source-debug1.png`
- `D:\Project\pilio\pilio-frontend\test-output\gemini-pilio-debug1.png`

这说明：

- 至少对 `debug1.png` 这个样例来说
- “纯核心算法输出不同”不是主因

### 2.2 可见水印实际上已经被去掉

右下角白色星形水印的裁片对比已经确认处理后消失。

相关裁片：

- 原图：`D:\Project\pilio\pilio-frontend\test-output\gemini-debug-crops\original-crop.png`
- 处理后：`D:\Project\pilio\pilio-frontend\test-output\gemini-debug-crops\processed-crop.png`

因此，“完全去不掉”这个判断并不准确。

更准确的说法是：

- 当前 `pilio-frontend` 的展示链路、默认参数、运行时封装，与开发者预览实际使用链路没有完全对齐
- 用户在页面上看到的结果，未必等于这次本地脚本直接调用核心得到的结果

## 3. 根因判断

## 3.1 两边核心库没有完全同步

当前两套代码分别是：

- `pilio-frontend`：`lib/gemini-watermark`
- `gemini-watermark-remover`：`src/core`

它们不是同一份真源。

已观察到的关键差异包括：

- `pilio-frontend/lib/gemini-watermark/core/image-data-processor.ts`
- `gemini-watermark-remover/src/core/watermarkProcessor.js`

其中开源库已有、但前端分叉里未完整跟上的逻辑包括：

- preview edge cleanup
- 与 preview 场景相关的收尾时序与 debug timing

关键标记可见于：

- `src/core/watermarkProcessor.js` 中的 `+edge-cleanup`
- `src/core/watermarkProcessor.js` 中的 `previewEdgeCleanupMs`

## 3.2 真正决定效果的是“runtime + core”，不是只有 core

开发者预览真正跑的并不只是 `sdk/*`。

当前更接近真实效果的链路在这些文件里：

- `src/shared/imageProcessing.js`
- `src/page/pageProcessRuntime.js`
- `src/shared/pageImageReplacement.js`
- `src/userscript/processingRuntime.js`

也就是说，真正影响“页面里看起来能不能稳定去掉”的，是：

- 默认处理参数
- blob 解码路径
- worker / main-thread fallback
- preview 替换策略
- page bridge
- userscript 特有兼容逻辑

而不是只看 `removeWatermarkFromImageData(...)` 这一层。

## 3.3 当前 `pilio-frontend` 默认更保守

已确认一个直接差异：

- `pilio-frontend/components/converter/hooks/use-client-processor.tsx`
  - 当前使用 `adaptiveMode: "auto"`
- `gemini-watermark-remover/src/shared/imageProcessing.js`
  - 默认是 `adaptiveMode: 'always'`

这会导致：

- 页面环境里的默认搜索/补偿策略更保守
- 某些边缘样例在 preview 或前端展示路径里，处理结果不如开发者预览激进

## 3.4 userscript 与浏览器页面运行时不能完全等同

这部分需要单独建模。

目前判断是：

- userscript 不能强依赖标准 Web Worker 运行条件
- 但开源库里已经有 inline worker / fallback 机制
- 因此 userscript 不应该成为浏览器页面 runtime 设计的上限约束

更合理的拆分是：

- 共用同一个 `core`
- 拆成不同 runtime

## 4. 设计目标

建议把 `D:\Project\gemini-watermark-remover` 作为唯一真源，目标如下：

1. `core` 成为唯一算法真源
2. `runtime-browser` 提供稳定、无副作用的浏览器纯处理入口
3. `runtime-userscript` 保留 userscript 专属 fallback / inline worker 差异，但不暴露整个宿主集成层
4. `pilio-frontend` 只保留一个很薄的接口层，不再长期维护整份分叉算法
5. 后续算法改进优先在开源库完成，再由上层项目同步版本

## 5. 推荐架构

建议在 `gemini-watermark-remover` 内部收敛成下面的结构：

```text
src/
  core/                  # 唯一算法真源
  shared/                # browser 与 userscript 共享的处理拼装层
  runtime/
    browser.js           # 面向页面 / pilio-frontend / 开发者预览
    userscript.js        # 面向 userscript
  sdk/                   # 现有稳定 SDK 入口
  page/                  # 页面注入与 bridge 细节
  userscript/            # userscript 宿主相关细节
```

推荐边界：

- `core/`
  - 只负责 watermark 检测、定位、修复、质量收尾
- `shared/`
  - 负责可复用的 blob decode、engine cache、canvas encode、fallback 组装
- `runtime/browser`
  - 负责给浏览器页面和 `pilio-frontend` 提供稳定公共 API
  - 只负责纯 blob 处理，不安装 page bridge，不依赖 Gemini 页面状态
- `runtime/userscript`
  - 负责 userscript 的 inline worker、宿主 fallback、窄处理 API
- `page/`
  - 继续承接页面桥接与 page adapter
  - 不纳入公共 runtime 子路径
- `shared/pageImageReplacement.js`
  - 继续承接 Gemini 页面替换与预览集成
  - 不视作 `runtime-browser` 的一部分

## 6. 推荐导出方案

当前 `package.json` 只导出了：

- `.`
- `./browser`
- `./image-data`
- `./node`

建议新增导出：

- `./runtime-browser`
- `./runtime-userscript`（experimental）

对应到包使用形态：

```ts
import { createBrowserRuntimeProcessor } from '@pilio/gemini-watermark-remover/runtime-browser';
import { createUserscriptRuntimeProcessor } from '@pilio/gemini-watermark-remover/runtime-userscript';
```

## 7. 最小 API 设计建议

这里建议用“实例式 API”，不要只导出一个纯函数。

原因：

- 适合缓存 `WatermarkEngine`
- 适合管理 worker / fallback 生命周期
- 适合保留 logger、timing debug、bridge、future flags
- 更适合 `pilio-frontend` 做薄适配层

建议的浏览器 runtime API：

```ts
export interface RuntimeProcessor {
  processWatermarkBlob(blob: Blob, options?: ProcessingOptions): Promise<{
    processedBlob: Blob | null;
    processedMeta: ProcessingMeta | null;
  }>;
  removeWatermarkFromBlob(blob: Blob, options?: ProcessingOptions): Promise<Blob | null>;
  dispose?(): void;
}

export function createBrowserRuntimeProcessor(options?: {
  logger?: ConsoleLike;
  createEngine?: () => PromiseLike<WatermarkEngine> | WatermarkEngine;
  defaultOptions?: ProcessingOptions;
}): RuntimeProcessor;
```

建议的 userscript runtime API：

```ts
export function createUserscriptRuntimeProcessor(options?: {
  workerCode?: string;
  env?: typeof globalThis;
  logger?: ConsoleLike;
}): RuntimeProcessor & {
  initialize?(): Promise<boolean>;
};
```

建议保留的几个原则：

- 默认 `adaptiveMode` 与开发者预览一致
- `processWatermarkBlob` 返回 `processedBlob + processedMeta`
- `removeWatermarkFromBlob` 作为便捷封装
- 允许 `dispose()`
- 不把 page bridge 细节泄露给 `pilio-frontend`
- `runtime-browser` 是无副作用处理入口，不隐式安装 bridge
- `runtime-userscript` 只承诺窄接口，宿主调试字段属于 optional / best-effort

## 8. `pilio-frontend` 侧接入方式

`pilio-frontend` 不建议继续维护完整分叉。

建议改成：

```text
pilio-frontend/
  lib/
    gemini-watermark-adapter/
      browser-runtime.ts
      types.ts
```

职责只保留：

- 调用开源库导出的 `runtime-browser`
- 把前端业务层需要的类型、错误、日志、参数做最小适配
- 逐步移除现有 `lib/gemini-watermark` 分叉实现

这样后续同步方式就会变成：

- 在 `gemini-watermark-remover` 更新 core / runtime
- `pilio-frontend` 只升级依赖和少量适配层

## 9. 推荐实施顺序

### 阶段 1A：在开源库中固化纯 runtime 导出与打包契约

先做最小收口，不要一开始就大迁移。

1. 新增 `src/runtime/browser.js`
2. 新增 `src/runtime/userscript.js`
3. 明确 `runtime-browser` 与 `page/pageProcessRuntime.js` 分离
4. 从现有 `shared/imageProcessing.js`、`userscript/processingRuntime.js` 中抽稳定入口
5. 更新 `package.json` 的 `exports`
6. 补充 `d.ts`
7. 补 package-consumer 级测试，锁住 tarball 导入、TS 编译、深层私有导入拒绝

### 阶段 1B：补强公共 runtime 合约测试

1. 锁住 `runtime-browser` 的无副作用导入/构造行为
2. 锁住 `runtime-browser` 默认 `adaptiveMode: 'always'`
3. 锁住 `runtime-userscript` 的 worker 初始化成功/失败 fallback
4. 锁住 `processedMeta` 的稳定字段与 optional 字段边界

### 阶段 2：用测试锁住“开发者预览行为”

重点不是只测函数能跑，而是锁住关键行为。

至少补这些：

1. `debug1-source.png` 的输出一致性测试
2. `runtime-browser` 与当前开发者预览主处理链的结果一致性测试
3. `runtime-userscript` 在无 worker 条件下仍可 fallback
4. `processedMeta` 中稳定字段保持不丢失；`selectionDebug` 等调试字段保持 optional / best-effort

### 阶段 3：`pilio-frontend` 改薄适配层

1. 新建 `lib/gemini-watermark-adapter`
2. `use-client-processor.tsx` 改为调用 `runtime-browser`
3. 保留一段过渡期兼容逻辑，并做双跑比对
4. 最后再删除旧分叉实现

## 10. 验收标准

改造完成后，至少要满足下面几点。

### 10.1 样例一致

对于 `debug1.png`：

- `gemini-watermark-remover` 本地 SDK
- `runtime-browser`
- `pilio-frontend`

输出应保持一致，至少在 hash 或可接受视觉阈值上等价。

对于公共包本身，还应满足：

- `pnpm pack` 后隔离 consumer 可成功导入 `./runtime-browser`
- `pnpm pack` 后隔离 consumer 可成功导入 `./runtime-userscript`
- TypeScript consumer 可成功编译这两个新子路径
- 深层私有导入 `@pilio/gemini-watermark-remover/src/...` 被显式拒绝

### 10.2 页面一致

对于开发者预览 / 页面预览：

- 页面里看到的 preview
- 用户下载得到的结果
- 本地直接处理得到的 blob

应尽量对齐，不应出现“预览像是修了，下载还是旧结果”。

### 10.3 userscript 可独立退化

即使某些宿主环境不适合 worker，也必须：

- 不阻塞主链路
- 有 main-thread fallback
- 不影响 `runtime-browser` 的设计上限

### 10.4 公共 runtime 边界稳定

- `runtime-browser` 在导入和构造时不产生页面副作用
- `runtime-browser` 不隐式安装 page bridge
- `runtime-userscript` 继续保持窄接口，宿主调试字段只按 optional / best-effort 暴露

## 11. 当前最重要的判断

这次排查里最值得保留的结论是：

> `pilio-frontend` 当前“不能去掉 `debug1.png`”并不是因为这张图对应的核心算法能力缺失，而是因为 `pilio-frontend` 没有真正复用 `gemini.pilio.ai` 当前在跑的那条 runtime 链路。

所以后续工作的重点应该是：

- 不再继续手工同步整份前端分叉
- 转为在 `gemini-watermark-remover` 里把 `core + runtime` 正式产品化导出
- 让 `pilio-frontend` 通过薄接口层复用

## 12. 建议的第一步实现

如果现在立刻开始推进，最值得先做的是：

1. 在 `src/runtime/browser.js` 中基于 `shared/imageProcessing.js` 做稳定实例导出
2. 在 `src/runtime/userscript.js` 中基于 `userscript/processingRuntime.js` 做稳定实例导出
3. 更新 `package.json` 导出
4. 补一个最小 consumer test，证明第三方项目能直接 import 并处理 `debug1-source.png`

先把“可复用 runtime 入口”建立起来，再做前端迁移，整体风险最低。

## 13. 本轮已完成项

截至 2026-04-16，本轮已完成：

1. `runtime-browser` 纯处理入口与类型声明
2. `runtime-userscript` 窄包装入口与类型声明
3. `package.json` 新增 `./runtime-browser` 与 `./runtime-userscript`
4. `pnpm pack` 隔离 consumer 与 TypeScript consumer 验证
5. 深层私有导入拒绝测试
6. `runtime-browser` 无副作用导入/构造测试
7. `runtime-userscript` worker 成功/失败 fallback 测试

当前下一步重点已经收敛为：

- 用真实样例补齐 `runtime-browser` 与当前页面主处理链的一致性测试
- 在 `pilio-frontend` 做薄 adapter + 双跑迁移
