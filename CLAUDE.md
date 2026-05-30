# 项目约定

This file provides guidance to Coding Agent when working with code in this repository.

## 项目概述

TaskLite 是一个轻量级、支持树状结构的 Obsidian 任务管理插件，兼容 Tasks 插件的 emoji 元数据格式。专注于编辑和渲染标准 Markdown 任务行，不实现 Tasks 查询语言。

## 常用命令

```bash
bun install          # 安装依赖
bun test             # 运行测试
bun run build        # 生产构建（tsc 类型检查 + esbuild 打包）
bun run dev          # 开发模式（watch）
bun run lint         # ESLint 检查
npm version patch    # 发布版本（会同步更新 manifest.json 和 versions.json）
```

测试文件在 `tests/` 目录，使用 `bun:test` 框架。

## 架构

入口：`src/main.ts` → 编译为 `main.js`，由 Obsidian 加载。

### 模块分层

- **`src/model/`** — 纯数据模型，不依赖 Obsidian API
  - `format.ts` — 任务行解析/序列化（`parseTaskLine` / `serializeTaskLine`），定义 `TaskLine`、`TaskMetadata`、emoji 符号常量 `TASK_SYMBOLS`
  - `status.ts` — `StatusRegistry`（符号 → 状态配置映射）和 `StatusType` 枚举（TODO/DONE/IN_PROGRESS/ON_HOLD/CANCELLED/NON_TASK/EMPTY）
  - `taskState.ts` — `applyTaskStatus` 状态变更逻辑
  - `taskIdentity.ts` — 基于 body 内容（排除 done/cancelled 日期）的任务身份匹配
  - `tree.ts` — `buildTaskTree` 将 Markdown 列表构建为 `TaskTree`（父子节点树），支持从 Obsidian `CachedMetadata.listItems` 或纯文本推断
  - `recurrence.ts` — 循环规则解析（every day/week/month/year 及 N 变体）

- **`src/editor/`** — 编辑器交互层
  - `toggle.ts` — 核心切换逻辑：`toggleTaskAtLine` 根据当前状态选择 finish/unfinish/cancel/uncancel，并递归处理子树和父链；支持循环任务自动创建下一个 occurrence
  - `apply.ts` — 将 toggle 结果应用到 Obsidian Editor
  - `externalReconcile.ts` — 监听 vault 文件变更，对非 TaskLite 触发的任务完成进行 reconcile
  - `recurrenceOccurrence.ts` — 构建循环任务的下一个 occurrence 内容

- **`src/rendering/`** — 编辑器渲染
  - `livePreview.ts` — CodeMirror 6 扩展，在 Live Preview 中拦截 checkbox 点击并走 TaskLite toggle 逻辑

- **`src/api/`** — 对外 API
  - `taskLiteCoreApi.ts` — `TaskLiteCoreApi` 接口，供外部插件调用（listTasks/finishTask/createTask 等）

- **`src/suggest/`** — 编辑器建议
  - `emojiSuggest.ts` — 在任务行输入 `@` 时弹出 emoji 字段建议

- **`src/core/registerCore.ts`** — 集中注册所有命令、编辑器扩展、设置面板

### 关键设计

- **树状感知切换**：toggle 一个任务时，会递归更新所有子任务（finish 时子任务全部标为 DONE，unfinish 时恢复 TODO），并向上冒泡检查父任务是否所有子任务都已完成
- **状态链**：`StatusRegistry.next()` 根据 `nextStatusSymbol` 决定下一个状态，形成循环链（如 ` ` → `x` → ` ` 或 ` ` → `/` → `x` → ` `）
- **任务身份匹配**：`taskIdentityKey` 忽略 done/cancelled 日期，仅基于 description + 其他元数据匹配同一任务
- **DocumentStore**：`TaskDocumentStore` 缓存已解析的文档树，监听 vault 事件自动失效/重建，避免重复解析

## 任务行格式

兼容 Tasks 插件 emoji 格式：
```
- [ ] 任务描述 📅 2026-01-01 ⏳ 2025-12-25 🔁 every week 🔺
```

支持的 emoji 字段：优先级（🔺⏫🔼🔽⏬）、开始/创建/计划/截止/完成/取消日期、循环、完成后、依赖、ID、block link。

## 国际化

`src/i18n.ts` 包含 `en` 和 `zh` 两套翻译。使用 `t("key")` 函数获取本地化字符串，通过 `window.moment.locale()` 或 `navigator.language` 自动检测语言。

## 版本与发布

- 当前版本：`0.3.1-alpha.7`（修复空括号 checkbox `- []` 导致的卡死，正则回退 + 防御性 guard）
- Agent 规则：每次做出用户可见的优化或打磨变更时，递增 prerelease alpha 版本号
- `npm version` 会运行 `version-bump.mjs` 同步 `manifest.json` 和 `versions.json`
- 推送匹配 `x.y.z` 格式的 tag 会触发 `.github/workflows/release.yml` 自动构建发布
- **发布流程**：`npm version` 之后必须立即 `git push && git push --tags`，确保 alpha 版本自动发布

## 测试

测试使用 `bun:test`，通过 mock `window.moment` 来模拟日期。测试覆盖解析、切换、循环、外部 reconcile、API 兼容等核心逻辑。
