# TaskLite Plugin API

> **Version**: 0.4.7-beta.3
> **Plugin ID**: `taskslite`

本文档面向希望基于 TaskLite 插件开发新插件的开发者。

---

## 目录

1. [接入方式](#1-接入方式)
2. [核心 API — `TaskLiteCoreApi`](#2-核心-api--tasklitecoreapi)
   - [listTasks](#21-listtasks)
   - [filterTasks](#22-filtertasks)
   - [listFrontmatterTasks](#23-listfrontmattertasks)
   - [createTask](#24-createtask)
   - [deleteTask](#24-deletetask)
   - [editTask](#25-edittask)
   - [updateTaskStatus](#26-updatetaskstatus)
   - [executeTasksToggleCommand](#27-executetaskstogglecommand)
   - [listAssignees](#28-listassignees)
   - [generateTaskId](#29-generatetaskid)
3. [数据结构参考](#3-数据结构参考)
   - [TaskLiteTaskRecord](#tasklitetaskrecord)
   - [TaskData](#taskdata)
   - [EditTaskPatch](#edittaskpatch)
   - [StatusConfiguration](#statusconfiguration)
4. [设计约定与注意事项](#4-设计约定与注意事项)
5. [完整示例](#5-完整示例)
6. [版本历史与兼容性](#6-版本历史与兼容性)

---

## 1. 接入方式

### 1.1 获取插件实例

在 Obsidian 插件中，通过 `app.plugins.plugins` 获取 TaskLite 插件实例：

```typescript
import type TaskLitePlugin from "path-to-tasklite/src/main"; // 仅用于类型

function getTaskLiteApi(app: App) {
  const plugin = (app as any).plugins?.plugins?.["taskslite"] as TaskLitePlugin | undefined;
  if (!plugin) throw new Error("TaskLite 插件未启用");
  return plugin.api;
}
```

### 1.2 声明依赖

在你的 `manifest.json` 中声明对 TaskLite 的依赖：

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "minAppVersion": "1.8.0",
  "dependencies": {
    "taskslite": "0.4.0-alpha.0"
  }
}
```

### 1.3 防御性获取

建议在插件加载时检测 TaskLite 是否存在，避免在其未启用时崩溃：

```typescript
export default class MyPlugin extends Plugin {
  private taskLiteApi: TaskLiteCoreApi | null = null;

  async onload() {
    // 等待所有插件加载完成后再获取
    this.app.workspace.onLayoutReady(() => {
      const tl = (this.app as any).plugins?.plugins?.["taskslite"];
      this.taskLiteApi = tl?.api ?? null;
      if (!this.taskLiteApi) {
        new Notice("需要安装并启用 TaskLite 插件");
      }
    });
  }
}
```

---

## 2. 核心 API — `TaskLiteCoreApi`

所有方法均通过 `plugin.api` 访问。接口定义：

```typescript
interface TaskLiteCoreApi {
  listTasks(options?: ListTasksOptions): Promise<TaskLiteTaskRecord[]>;
  filterTasks(records: TaskLiteTaskRecord[], query: string): TaskLiteTaskRecord[];
  listFrontmatterTasks(): Promise<TaskLiteTaskRecord[]>;
  getTask(path: string, lineNumber: number): Promise<TaskLiteTaskRecord | null>;
  findTaskById(id: string, options?: FindTaskOptions): Promise<TaskLiteTaskRecord | null>;
  createTask(input: CreateTaskInput): Promise<void>;
  deleteTask(path: string, lineNumber: number): Promise<boolean>;
  editTask(path: string, lineNumber: number, patch: EditTaskPatch): Promise<boolean>;
  updateTaskStatus(path: string, lineNumber: number, statusSymbol: string): Promise<boolean>;
  cycleTaskStatus(path: string, lineNumber: number, direction?: "next" | "previous"): Promise<boolean>;
  executeTasksToggleCommand(line: string, path: string): string;
  listAssignees(): Promise<string[]>;
  listStatuses(): StatusConfiguration[];
  getStatusCycle(): string[];
  generateTaskId(description: string, options?: { isRecurring?: boolean; dueDate?: string | null }): string;
}
```

---

### 2.1 `listTasks`

列出 Vault 中所有满足条件的任务，包含普通行级任务与在 Frontmatter 中使用 `task: true` 标记的文件级任务（默认只返回未完成、未取消的顶层任务）。

```typescript
listTasks(options?: ListTasksOptions): Promise<TaskLiteTaskRecord[]>

interface ListTasksOptions {
  includeCompleted?: boolean;  // 是否包含已完成 (DONE) 的任务，默认 false
  includeCancelled?: boolean;  // 是否包含已取消 (CANCELLED) 的任务，默认 false
  includeChildren?: boolean;   // 是否包含子任务，默认 false
  query?: string;              // DQL-like 查询字符串，在 include* 选项之后应用
}
```

**返回**：[`TaskLiteTaskRecord[]`](#tasklitetaskrecord) 数组，每项对应一个任务行。

**示例：**

```typescript
// 获取所有待办顶层任务
const todos = await api.listTasks();

// 获取全部任务（包括完成/取消/子任务）
const all = await api.listTasks({
  includeCompleted: true,
  includeCancelled: true,
  includeChildren: true,
});

// 按截止日期过滤
const today = new Date().toISOString().slice(0, 10); // "2026-05-31"
const dueTodayOrBefore = todos.filter(
  (r) => r.task.dates.due && r.task.dates.due <= today
);
```

> **性能提示**：TaskLite 内部维护了一个 `TaskDocumentStore` 缓存，`listTasks` 会优先使用缓存数据。首次调用会遍历整个 Vault，之后的调用非常快。

---

### 2.2 `filterTasks`

对已获取的任务列表执行 DQL-like 过滤。适合外部插件已经拿到 `listTasks()` 结果后继续筛选，避免重复扫描 Vault。

```typescript
filterTasks(records: TaskLiteTaskRecord[], query: string): TaskLiteTaskRecord[]
```

支持的常用表达式：

```typescript
status = "TODO"
due <= date(today)
scheduled <= date(today)
priority = ""
path =~ "Work/"
tags contains "#work"
assignee = "Alice"
hasChildren = true
parentLine = null
description contains "xxx"
AND / OR / NOT / 括号
```

**说明**：
- `date(today)` 按当前日期求值，返回 `YYYY-MM-DD`。
- `=~` 执行字符串包含匹配。
- `contains` 执行字符串包含匹配，适合 `tags`、`description` 等字段。
- 缺失日期字段按 `null` 处理，因此 `due <= date(today)` 不会匹配没有截止日期的任务。
- `assignee` 字段支持使用 `&` 作为分隔符标记多位负责人（如 `👤 Alice & Bob`）。在过滤时，`assignee = "Alice"` 或 `assignee = "Bob"` 都能精准匹配到该任务，而 `assignee != "Alice"` 则会在包含 "Alice" 时返回不匹配。为了保持向前兼容，DQL 查询仍支持 `person` 作为 `assignee` 的别名（如 `person = "Alice"`）。

---

### 2.4 `createTask`

在指定文件末尾（或指定父任务下方）插入一个新任务行。

```typescript
createTask(input: CreateTaskInput): Promise<void>

interface CreateTaskInput {
  description: string;         // 任务描述（必填，文件级任务会成为文件标题）
  status?: string;             // 状态符号，默认 " "（待办）
  priority?: string | null;    // 优先级名称或 emoji，如 "high" 或 "⏫"
  dates?: {
    start?: string | null;     // 开始日期 "YYYY-MM-DD"
    scheduled?: string | null; // 计划日期
    due?: string | null;       // 截止日期
  };
  recurrence?: string | null;    // 重复规则，如 "every week"
  onCompletion?: string | null;  // 完成行为
  id?: string | null;            // 任务 ID
  dependsOn?: string | null;     // 依赖的任务 ID
  assignee?: string[];           // 负责人数组，如 ["Alice", "Bob"]
  path?: string;                 // 目标文件路径，默认 "Tasks/New_Tasks.md"
  parentLineNumber?: number;     // 父任务行号（0-indexed），新任务插入到该行正下方并自动缩进
  isFileTask?: boolean;          // 是否创建为文件级任务（编码在 YAML frontmatter 中）
}
```

**行为：**
- 若目标文件不存在，自动创建。
- 若提供了 `parentLineNumber`，新任务将插入父任务的正下方，并自动继承父任务的缩进加一个 Tab。
- 若未提供 `parentLineNumber`，任务追加到文件末尾。
- 未传的可选字段使用默认值（`null` 或空），不会从文件中推断。
- **文件级任务**（`isFileTask: true`）：`description` 会成为文件的标题（frontmatter 中的 description 字段）。

**示例：**

```typescript
// 追加到默认 inbox 文件
await api.createTask({ description: "写周报", dates: { due: "2026-06-07" } });

// 追加到指定文件
await api.createTask({ description: "Review PR", path: "Work/Tasks.md" });

// 创建为某任务的子任务（父任务在第 5 行）
await api.createTask({
  description: "子任务",
  path: "Work/Tasks.md",
  parentLineNumber: 5,
});

// 创建一个高优先级循环任务
await api.createTask({
  description: "站会",
  priority: "⏫",
  recurrence: "every weekday",
  dates: { start: "2026-06-02" },
});

// 创建文件级任务，description 成为文件标题
await api.createTask({
  description: "项目 Alpha",
  path: "Projects/Alpha.md",
  isFileTask: true,
  dates: { due: "2026-06-30" },
  priority: "⏫",
});
```

---

### 2.3 `deleteTask`

删除指定任务及其**完整子树**（所有后代任务行一并删除）。

```typescript
deleteTask(path: string, lineNumber: number): Promise<boolean>
```

**参数：**
- `path`：文件在 Vault 中的相对路径，如 `"Work/Tasks.md"`。
- `lineNumber`：任务所在行号（0-indexed）。

**返回**：`true` 表示找到并删除成功；`false` 表示文件不存在或该行没有任务。

**行为：**
- 递归删除目标任务及其所有子任务（整个子树）。
- 子任务不会被"升级"或移动，而是随父任务一起被删除。
- 只影响文件内容，不会弹出任何确认对话框。

**示例：**

```typescript
const records = await api.listTasks();
const target = records.find((r) => r.task.metadata.description === "旧项目");

if (target) {
  const deleted = await api.deleteTask(target.path, target.lineNumber);
  console.log(deleted ? "已删除" : "未找到");
}
```

> ⚠️ **不可撤销**：删除操作直接修改文件，Obsidian 无法通过 Ctrl+Z 撤销。建议在调用前向用户确认。

---

### 2.5 `editTask`

**原子地**修改任务的 metadata 字段。只有 `patch` 中显式传入的字段才会被更新，未提及的字段保持不变。

```typescript
editTask(path: string, lineNumber: number, patch: EditTaskPatch): Promise<boolean>

type EditTaskPatch = {
  description?: string;        // 任务描述文本
  priority?: string | null;    // 优先级名称或 emoji，如 "high" 或 "⏫"，null 表示清除
  dates?: {
    start?: string | null;     // 开始日期 "YYYY-MM-DD"，null 表示清除
    scheduled?: string | null; // 计划日期
    due?: string | null;       // 截止日期
  };
  recurrence?: string | null;    // 重复规则，如 "every week"，null 清除
  onCompletion?: string | null;  // 完成行为："delete" 或 "keep"，null 清除
  id?: string | null;            // 任务 ID（用于 dependsOn），null 清除
  dependsOn?: string | null;     // 依赖的任务 ID，null 清除
  assignee?: string[];           // 负责人数组，如 ["Alice", "Bob"]
}
```

**返回**：`true` 表示找到并修改成功；`false` 表示文件不存在或该行没有任务。

**关键约定：**
- `editTask` **不接受 `status` 或 `statusSymbol` 字段**。状态变更请使用专用的 `updateTaskStatus` 方法，它会正确处理级联逻辑（子任务、父任务传播、重复任务等）。
- `editTask` **不接受状态事件日期**（`created`、`done`、`cancelled`）。这些日期由状态变更事件自动产生：`created` 随任务创建，`done` 和 `cancelled` 由 `updateTaskStatus` 自动维护。只接受"规划类"日期（`start`、`scheduled`、`due`）。
- `patch.dates` 中的每个子字段均独立处理：传 `undefined` = 不变，传 `null` = 清除该日期，传字符串 = 设置新值。
- 此操作**不触发任何级联逻辑**，只做字段级别的原子修改。

**示例：**

```typescript
// 仅修改截止日期
await api.editTask("Work/Tasks.md", 3, {
  dates: { due: "2026-06-30" },
});

// 修改描述和优先级
await api.editTask("Work/Tasks.md", 3, {
  description: "修改后的任务名称",
  priority: "⏫",
});

// 清除截止日期（设为 null）
await api.editTask("Work/Tasks.md", 3, {
  dates: { due: null },
});

// 设置重复规则
await api.editTask("Work/Tasks.md", 3, {
  recurrence: "every month on the 1st",
});

// 给任务设置 ID（用于 dependsOn）
await api.editTask("Work/Tasks.md", 3, {
  id: "task-001",
});
```

---

### 2.6 `updateTaskStatus`

将任务状态更改为指定的复选框符号字符，触发相应的级联流转逻辑与循环逻辑。

```typescript
updateTaskStatus(path: string, lineNumber: number, statusSymbol: string): Promise<boolean>
```

**不同状态符号的行为（受用户设置影响）：**
* **`"x"` (完成状态)**:
  - 将任务状态改为 `DONE`。
  - **阻塞约束 (Strict Blocking)**: 若任务有依赖项且存在未完成的依赖（通过 `⛔ dependsOn` 关联），在尝试修改状态为 `DONE` 时将**抛出 Error 异常**并阻止操作。
  - 若设置了 `setDoneDate: true`，自动填写当天日期到 `✅` 字段。
  - 若 `cascadeFinish: true`，递归地将所有子任务也标记为完成。
  - 若 `parentOnFinish: true`，当所有兄弟子任务都完成后，自动将父任务也标记为完成。
  - 若任务有重复规则（`🔁`），自动生成下一个周期的新任务。
* **`"-"` (取消状态)**:
  - 将任务状态改为 `CANCELLED`。
  - 若 `setCancelledDate: true`，自动填写 `❌` 取消日期。
  - 若 `cascadeCancel: true`，递归取消所有子任务。
  - 若 `parentOnCancel: true`，当所有非取消子任务都完成后，父任务自动完成。
* **`" "` (未完成/待办状态)**:
  - 清除任务的完成或取消日期。
  - 如果原状态是完成，触发未完成级联逻辑（若 `cascadeUnfinish: true` 递归恢复子任务；若 `parentOnUnfinish: true` 递归恢复父任务）。
  - 如果原状态是取消，触发恢复级联逻辑（若 `cascadeUncancel: true` 递归恢复子任务）。
* **`"/"` (进行中) 或其他字符**:
  - 精准修改该行的状态字符，不触发任何级联逻辑。

**返回**：`true` = 操作成功；`false` = 任务未找到或无需变更。

**示例：**

```typescript
const record = (await api.listTasks())[0];

// 标记为完成（触发级联与循环逻辑）
try {
  await api.updateTaskStatus(record.path, record.lineNumber, "x");
} catch (err) {
  // 若该任务受到前置任务阻塞，将抛出 Error 异常
  console.error("更新状态失败:", err.message);
}

// 标记为进行中（仅更新本行复选框符号）
await api.updateTaskStatus(record.path, record.lineNumber, "/");

// 恢复为待办（触发恢复或恢复待办级联逻辑）
await api.updateTaskStatus(record.path, record.lineNumber, " ");
```

---

### 2.7 `executeTasksToggleCommand`

对一个**单独的任务行字符串**执行 Tasks 插件兼容的 toggle 逻辑，返回修改后的行字符串。此方法不直接修改文件，主要供与 Tasks 插件兼容的外部系统（如 Dataview 渲染的任务）调用。

```typescript
executeTasksToggleCommand(line: string, path: string): string
```

**参数：**
- `line`：任务行的完整文本字符串。
- `path`：任务所在文件的路径（用于查找已打开的编辑器，以获取最新的文件内容）。

**返回**：修改后的行文本（可能是多行，用 `\n` 连接，例如生成了重复任务时）。

**阻塞约束**：若任务行带有 `⛔ dependsOn` 且其依赖的前置任务尚未在 Vault 中完成，当尝试勾选完成时，将**抛出 Error 异常**并阻止切换。

**示例：**

```typescript
const original = "- [ ] 每周报告 🔁 every week 📅 2026-05-31";
const toggled = api.executeTasksToggleCommand(original, "Work/Tasks.md");
// 返回：已完成行 + 新的重复任务行
```

> 这个方法主要用于**兼容 Tasks 插件的 Dataview 渲染场景**。如果你只是想操作 Vault 文件中的任务，请优先使用 `updateTaskStatus` 方法。

---

### 2.8 `listAssignees`

获取整个 Vault 中所有任务中出现的唯一负责人（assignee）集合，按字母顺序排序。

```typescript
listAssignees(): Promise<string[]>
```

**返回**：`string[]` 负责人名称数组。

**示例：**

```typescript
const assignees = await api.listAssignees();
console.log("库中所有负责人：", assignees); // ['Alice', 'Bob', 'Sunny']
```

---

### 2.9 `generateTaskId`

根据任务描述生成语义化 ID。英文单词取首字母转小写并用连字符连接，中文字符转拼音首字母并用连字符连接，基础 ID 长度限制为 8 字符。循环任务会添加日期后缀，Vault 中已存在的重复 ID 会添加随机 4 字符后缀。

```typescript
generateTaskId(description: string, options?: {
  isRecurring?: boolean;
  dueDate?: string | null;
}): string
```

**参数：**
- `description`：任务描述文本。
- `options`：可选配置。
  - `isRecurring`：是否为循环任务，若是则添加日期后缀。
  - `dueDate`：截止日期，格式 `YYYY-MM-DD`，若未提供则使用当前日期。

**返回**：生成的语义化 ID 字符串。

**行为：**
- 英文单词取首字母（如 `"Review PR"` → `"rp"`）。
- 中文字符转拼音首字母（如 `"写周报"` → `"xzb"`）。
- 基础 ID 最长 8 字符。
- 循环任务追加日期后缀（如 `"rp-2026-06-13"`）。
- 若 ID 在 Vault 中已存在，追加随机 4 字符后缀（如 `"rp-a3b2"`）。

**示例：**

```typescript
// 基本用法
const id1 = api.generateTaskId("Review PR");
// 可能返回 "rp"

// 循环任务
const id2 = api.generateTaskId("站会", { isRecurring: true, dueDate: "2026-06-15" });
// 可能返回 "zh-2026-06-15"

// 结合 createTask 使用
const id = api.generateTaskId("写周报", { isRecurring: true });
await api.createTask({
  description: "写周报",
  id: id,
  recurrence: "every week",
});
```

> **提示**：此方法会自动检测 Vault 中已存在的任务 ID，确保生成的 ID 唯一。适合在创建任务前调用，将返回的 ID 传入 `createTask` 的 `id` 字段。

---

## 3. 数据结构参考

### `TaskLiteTaskRecord`

`listTasks` 和 `listFrontmatterTasks` 返回的统一任务记录：

```typescript
interface TaskLiteTaskRecord {
  path: string;          // 文件路径，如 "Work/Tasks.md"
  basename: string;      // 文件名（无扩展名），如 "Tasks"
  lineNumber: number;    // 任务所在行号（0-indexed），若为文件级 Frontmatter 任务则固定为 -1
  parentLine: number | null; // 父任务行号，null 表示顶层任务（文件级任务恒为 null）
  depth: number;         // 在树中的深度（0 = 顶层列表项，-1 = 文件级 Frontmatter 任务）
  hasChildren: boolean;  // 是否有子级（文件级任务表示正文中是否含行任务）
  task: TaskData;        // 任务逻辑数据对象（见下文）
}
```

**YAML Frontmatter 字段格式示意：**

```yaml
---
task: true
status: " "
description: "项目 Alpha"
due: "2026-06-30"
priority: "⏫"
recurrence: "every month"
onCompletion: "delete"
---
```

### `TaskData`

完整的任务数据模型：

```typescript
interface TaskData {
  status: StatusType;            // 语义状态类型，如 "TODO"、"DONE"、"CANCELLED"、"IN_PROGRESS"
  description: string;           // 任务描述（已去除所有 emoji 元数据）
  priority: string | null;       // 优先级 emoji，如 "🔺"、"⏫"、"🔼"、"🔽"、"⏬"
  dates: {
    start: string | null;        // 🛫 开始日期
    created: string | null;      // ➕ 创建日期
    scheduled: string | null;    // ⏳ 计划日期
    due: string | null;          // 📅 截止日期
    done: string | null;         // ✅ 完成日期
    cancelled: string | null;    // ❌ 取消日期
  };
  recurrence: string | null;     // 🔁 重复规则文本
  onCompletion: string | null;   // 🏁 完成行为（"delete" | "keep"）
  id: string | null;             // 🆔 任务 ID
  dependsOn: string | null;      // ⛔ 依赖 ID
  assignee: string[];            // 👤 负责人
  blockLink: string | null;      // Obsidian 块引用，如 "^abc123"（仅行任务，文件任务为 null）
  tags: string[];                // 提取的标签列表，如 ["#work", "#urgent"]
}
```

**优先级名称与 Emoji 对照表：**

| 优先级名称 | Emoji | 描述 |
|------------|-------|------|
| `highest`  | `🔺`  | 最高 |
| `high`     | `⏫`  | 高   |
| `medium`   | `🔼`  | 中   |
| `low`      | `🔽`  | 低   |
| `lowest`   | `⏬`  | 最低 |

### `EditTaskPatch`

`editTask` 的修改入参，所有字段可选：

```typescript
type EditTaskPatch = {
  description?: string;
  priority?: string | null;
  dates?: {
    start?: string | null;
    scheduled?: string | null;
    due?: string | null;
  };
  recurrence?: string | null;
  onCompletion?: string | null;
  id?: string | null;
  dependsOn?: string | null;
  assignee?: string[];
}
```

### `StatusConfiguration`

状态的完整描述：

```typescript
interface StatusConfiguration {
  symbol: string;            // 状态字符，如 " "、"x"、"/"、"-"
  name: string;              // 可读名称，如 "Todo"、"Done"
  nextStatusSymbol: string;  // 切换后的下一状态字符
  availableAsCommand: boolean;
  type: StatusType;          // 语义类型（见下）
}

type StatusType =
  | "TODO"        // 待办
  | "DONE"        // 已完成
  | "IN_PROGRESS" // 进行中
  | "ON_HOLD"     // 暂停
  | "CANCELLED"   // 已取消
  | "NON_TASK"    // 非任务项
  | "EMPTY";      // 空状态
```

**默认状态配置：**

| symbol | name        | type         | nextSymbol |
|--------|-------------|--------------|-----------|
| ` `    | Todo        | `TODO`       | `x`       |
| `x`    | Done        | `DONE`       | ` `       |
| `/`    | In progress | `IN_PROGRESS`| `x`       |
| `-`    | Cancelled   | `CANCELLED`  | ` `       |

---

## 4. 设计约定与注意事项

### 4.1 行号的稳定性

所有 API 均以**行号（lineNumber）**定位任务，这是一个在文件修改后可能改变的值。

**建议：**
- 每次操作前通过 `listTasks()` 重新获取最新的行号，不要缓存行号跨操作使用。
- 如需稳定标识一个任务，使用 `🆔` 字段（`task.metadata.id`）作为逻辑 ID，再通过 `listTasks()` 查找对应的当前行号。

```typescript
// 推荐：通过 ID 定位任务
async function findByTaskId(api: TaskLiteCoreApi, taskId: string) {
  const records = await api.listTasks({ includeCompleted: true, includeChildren: true });
  return records.find((r) => r.task.metadata.id === taskId);
}
```

### 4.2 status 变更的正确姿势

**不要**用 `editTask` 修改 `status`——`EditTaskPatch` 故意没有 `status` 字段。

**原因**：状态变更会触发复杂的业务逻辑（子树级联、父任务传播、重复任务生成），这些逻辑只有专用方法才能正确处理。

```typescript
// ❌ 错误：editTask 不能改状态
await api.editTask(path, line, { status: "x" }); // 类型错误

// ✅ 正确：使用专用状态转换方法
await api.updateTaskStatus(path, line, "x"); // 完成（含级联）
await api.updateTaskStatus(path, line, "-"); // 取消（含级联）
await api.updateTaskStatus(path, line, " "); // 恢复（含级联）
```

### 4.3 删除操作的不可逆性

`deleteTask` 直接调用 `app.vault.modify`，Obsidian 不提供文件内容级别的撤销。**务必在删除前向用户确认**：

```typescript
async function safeDelete(app: App, api: TaskLiteCoreApi, record: TaskLiteTaskRecord) {
  const confirmed = await new Promise<boolean>((resolve) => {
    const modal = new ConfirmModal(app, `确定删除"${record.task.metadata.description}"吗？`, resolve);
    modal.open();
  });
  if (confirmed) await api.deleteTask(record.path, record.lineNumber);
}
```

### 4.4 并发写入

TaskLite 的每个 API 调用都会读取文件、修改内存、写回文件。**避免并发调用同一文件的写操作**，否则可能出现数据覆盖：

```typescript
// ❌ 危险：并发修改同一文件
await Promise.all([
  api.updateTaskStatus("Tasks.md", 3, "x"),
  api.editTask("Tasks.md", 5, { dates: { due: "2026-06-01" } }),
]);

// ✅ 安全：顺序执行
await api.updateTaskStatus("Tasks.md", 3, "x");
await api.editTask("Tasks.md", 5, { dates: { due: "2026-06-01" } });
```

### 4.5 日期格式

所有日期字段均使用 **`YYYY-MM-DD`** 格式的字符串：

```typescript
const today = new Date().toISOString().slice(0, 10); // "2026-05-31"
await api.editTask(path, line, { dates: { due: today } });
```

---

## 5. 完整示例

### 示例 1：待办任务看板面板

```typescript
import { Plugin, ItemView, WorkspaceLeaf } from "obsidian";
import type { TaskLiteCoreApi, TaskLiteTaskRecord } from "tasklite-path/api/taskLiteCoreApi";

export default class TaskBoardPlugin extends Plugin {
  async onload() {
    this.registerView("task-board", (leaf) => new TaskBoardView(leaf, this.app));
    this.addRibbonIcon("layout-dashboard", "任务看板", () => {
      this.app.workspace.getLeaf(true).setViewState({ type: "task-board" });
    });
  }
}

class TaskBoardView extends ItemView {
  getViewType() { return "task-board"; }
  getDisplayText() { return "任务看板"; }

  async onOpen() {
    const api = getTaskLiteApi(this.app);
    const records = await api.listTasks({ includeChildren: true });

    const today = new Date().toISOString().slice(0, 10);
    const overdue = records.filter((r) => r.task.metadata.dates.due && r.task.metadata.dates.due < today);
    const dueToday = records.filter((r) => r.task.metadata.dates.due === today);
    const upcoming = records.filter((r) => r.task.metadata.dates.due && r.task.metadata.dates.due > today);
    const noDue = records.filter((r) => !r.task.metadata.dates.due);

    this.renderColumn("逾期", overdue, api);
    this.renderColumn("今日", dueToday, api);
    this.renderColumn("即将到来", upcoming, api);
    this.renderColumn("无截止日期", noDue, api);
  }

  private renderColumn(title: string, records: TaskLiteTaskRecord[], api: TaskLiteCoreApi) {
    const col = this.contentEl.createDiv({ cls: "board-column" });
    col.createEl("h3", { text: `${title} (${records.length})` });
    for (const r of records) {
      const card = col.createDiv({ cls: "task-card" });
      card.createEl("p", { text: r.task.metadata.description });

       const btn = card.createEl("button", { text: "完成" });
      btn.addEventListener("click", async () => {
        await api.updateTaskStatus(r.path, r.lineNumber, "x");
        card.remove(); // 乐观 UI 更新
      });
    }
  }
}
```

### 示例 2：批量延期所有逾期任务

```typescript
async function postponeOverdueTasks(api: TaskLiteCoreApi, daysToAdd: number) {
  const records = await api.listTasks();
  const today = new Date().toISOString().slice(0, 10);

  for (const r of records) {
    const due = r.task.metadata.dates.due;
    if (!due || due >= today) continue;

    // 计算新截止日期
    const newDue = new Date(due);
    newDue.setDate(newDue.getDate() + daysToAdd);
    const newDueStr = newDue.toISOString().slice(0, 10);

    await api.editTask(r.path, r.lineNumber, {
      dates: { due: newDueStr },
    });
    console.log(`延期：${r.task.metadata.description}  ${due} → ${newDueStr}`);
  }
}

// 调用：延期 7 天
await postponeOverdueTasks(api, 7);
```

### 示例 3：从外部数据创建任务

```typescript
interface ExternalTodo {
  title: string;
  due?: string;
  priority?: "high" | "medium" | "low";
}

const PRIORITY_EMOJI: Record<string, string> = {
  high: "⏫",
  medium: "🔼",
  low: "🔽",
};

async function importExternalTodos(api: TaskLiteCoreApi, todos: ExternalTodo[]) {
  for (const todo of todos) {
    await api.createTask({
      description: todo.title,
      priority: todo.priority ? PRIORITY_EMOJI[todo.priority] : undefined,
      dates: todo.due ? { due: todo.due } : undefined,
      path: "Inbox/Imported.md",
    });
  }
}
```

### 示例 4：任务完成后自动归档

```typescript
// 监听文件修改，检测新完成的任务并移动到归档文件
async function archiveCompletedTasks(app: App, api: TaskLiteCoreApi) {
  const allRecords = await api.listTasks({
    includeCompleted: true,
    includeChildren: true,
  });

  const completed = allRecords.filter(
    (r) => r.task.status.type === "DONE" && r.path !== "Archive/Done.md"
  );

  for (const r of completed) {
    // 1. 在归档文件中创建同样的任务
    await api.createTask({
      description: r.task.metadata.description,
      status: r.task.status.symbol,
      priority: r.task.metadata.priority,
      dates: {
        start: r.task.metadata.dates.start,
        scheduled: r.task.metadata.dates.scheduled,
        due: r.task.metadata.dates.due,
      },
      path: "Archive/Done.md",
    });
    // 2. 删除原文件中的任务（含子树）
    await api.deleteTask(r.path, r.lineNumber);
  }
}
```

---

## 6. 版本历史与兼容性

| 版本 | 新增 API |
|------|---------|
| 0.4.7-beta.3 | 修正 assignee 缓存刷新：启动和文件变化后从当前 vault 任务重新计算负责人集合 |
| 0.4.7-beta.2 | 修正 assignee 建议与解析：多人负责人只使用 `&` 分隔，避免误产生 `Sunny-Mary` 形式 |
| 0.4.7-beta.1 | 新增 `getTask`、`findTaskById`、`cycleTaskStatus`、`listStatuses`、`getStatusCycle`，用于更丰富的任务定位和状态循环控制 |
| 0.4.6 | 新增 `generateTaskId` API，根据任务描述生成语义化 ID |
| 0.4.5 | 新增 `listAssignees` API，返回库中所有负责人的去重集合 |
| 0.4.3-alpha.0 | `listTasks` 现在返回所有任务（包括 Frontmatter 定义的文件级任务和普通行级任务） |
| 0.4.2-alpha.0 | 新增 DQL-like 查询过滤：`listTasks({ query })` 和 `filterTasks(records, query)`，支持常用字段比较、`contains`、`=~`、`AND`/`OR`/`NOT` 与括号 |
| 0.4.1-alpha.4 | 状态管理重构：统一状态变更 API 接口为 `updateTaskStatus` 并支持传入状态符号（包含级联逻辑及循环功能），移除冗余的 `finishTask`/`unfinishTask`/`cancelTask`/`uncancelTask` 方法，且从 `editTask` 中去除了临时状态修改属性 |
| 0.4.1-alpha.0 | 统一任务数据模型：合并行任务和文件级任务的数据结构与接口 (TaskData/TaskLiteTaskRecord)，移除了冗余的 metadata 嵌套与 FrontmatterTaskRecord 类型，frontmatter 任务的 depth 调整为 -1 |
| 0.4.0-alpha.0 | `deleteTask`、`editTask`、`EditTaskPatch` |
| 0.3.x | `listTasks`、`createTask`、`executeTasksToggleCommand` |

### 兼容性说明

- API 暴露的接口（`TaskLiteCoreApi`）**目前不提供正式的稳定性保证**（alpha 阶段）。
- 在 `0.4.0` 正式版发布前，接口签名可能还会调整，升级前请关注 [CHANGELOG](https://github.com/SunnyYYLin/obsidian-tasklite/releases)。
- `editTask` 故意不支持修改 `status`，这是设计决策而非遗漏，未来版本不会改变。
- `deleteTask` 的子树删除策略（递归删除所有后代）在未来版本中可能通过选项扩展，但默认行为不变。
