# Plan Cached Snapshot 与 Section Delta 设计

日期：2026-08-13  
宿主：Pi Coding Agent 0.73.1  
范围：Long Horizon Extension 的 plan context 与 prompt-cache 策略

## 1. 目标

Harness 不区分 `plan.md` 的修改来源。Human、Agent、bash、外部编辑器或脚本造成的变化，都通过比较磁盘上的 canonical `plan.md` 识别。

本设计把当前“每次 LLM 调用都临时重建 plan working set”的机制改为：

1. 在一个 compaction 周期开始时，向 session 追加一条隐藏、持久、参与 LLM context 的完整 Plan Cached Snapshot。
2. 周期内只要 plan section 发生变化，就追加该 section 的完整最新原文。
3. 后出现的相同 section ID 永远覆盖 prompt 中更早的版本。
4. section 删除通过 tombstone 覆盖旧版本。
5. 下一次 compaction 成功后，以当前完整 `plan.md` 建立新基线；此前 snapshot 和 updates 由 compaction 压缩，不再作为当前增量链的基线。

目标是让长会话中的 plan 前缀保持字节稳定，提升 provider prompt cache 的前缀复用率，同时保持模型看到的 plan 语义与磁盘一致。

## 2. 边界

- `plan.md` 是唯一 canonical plan；session 中的 snapshot/update 只是给模型使用的缓存表示。
- 不修改 Pi、`pi-agent-core` 或 provider cache-control 协议。
- `progress.md`、Git、ownership 和 recovery hints 仍由 `context` hook 临时追加，因为它们体积小且变化频繁。
- Snapshot 和 Update 使用 Pi 的 hidden custom message：参与 LLM context、写入 session，但 `display: false`，不在聊天 UI 中显示。
- `pi.appendEntry()` 只适合不参与 context 的状态，不能替代 Snapshot/Update 消息。
- v1 不实现手工 cache breakpoint；只利用稳定消息前缀和 provider 原生缓存。

## 3. 消息布局

一个 compaction 周期内的逻辑布局为：

```text
Stable system prompt
Compaction summary / conversation history
[Plan Cached Snapshot]              immutable, persistent
Conversation and tool messages
[Plan Updates Since Cached Snapshot] immutable, persistent, zero or more
Conversation and tool messages
[Long-Horizon Query Snapshot]       immutable for one user query
```

Snapshot 和已经写入 session 的 Update 不允许被原地修改。新的变化只追加新消息，从而保持已有 prompt prefix 不变。

## 4. Snapshot 格式

```markdown
[Plan Cached Snapshot]

This is the canonical plan snapshot at the start of this cache generation.
Later Plan Updates override sections or structure appearing in this snapshot.

<完整 plan.md 原文>
```

Snapshot custom message details 保存 Harness 恢复所需但不发送给模型的 manifest：

```ts
interface PlanSnapshotDetails {
  version: 1;
  kind: "snapshot";
  generationId: string;
  planHash: string;
  structureHash: string;
  sections: Array<{
    id: string;
    hash: string;
  }>;
}
```

`generationId` 在每次成功 compaction 后重新生成。Snapshot 的 `sections` 表示该消息写入时已经观察到的完整状态。

## 5. Section Update 格式

一次检测可以包含多个变化 section，但每个 section 必须附带当前完整原文，不使用行级 diff：

```markdown
[Plan Updates Since Cached Snapshot]

The following plan sections have changed.
These updates override any older versions appearing earlier in the prompt.

## sec-core-interface

### 1.2 Core Interface
<!-- id: sec-core-interface -->

<1.2 当前完整原文>

## sec-refresh-token

### 3.2 Refresh Token Flow
<!-- id: sec-refresh-token -->

<3.2 当前完整原文>
```

如果同一个 section 后续再次变化，追加新的完整版本，不修改旧消息。模型必须以最后出现的相同 section ID 为准。

Update details 保存应用该 update 后的完整 observed manifest，便于 session resume 时直接恢复比较基准：

```ts
interface PlanUpdateDetails {
  version: 1;
  kind: "update";
  generationId: string;
  planHash: string;
  structureHash: string;
  sections: Array<{
    id: string;
    hash: string;
  }>;
  changedIds: string[];
  deletedIds: string[];
  structureChanged: boolean;
}
```

## 6. 删除语义

删除 section 时追加 tombstone：

```markdown
## sec-old-flow

<!-- deleted: true -->

This section has been removed from the canonical plan.
```

如果以后使用同一个 ID 重新创建 section，新的完整 section update 覆盖 tombstone。

修改 section ID 按两个变化处理：旧 ID 删除，新 ID 新增。Harness 不尝试猜测 rename。

## 7. Plan Structure Update

以下变化不完全属于某个 `###` section：

- plan 开头的说明或 front matter；
- `##` chapter 标题；
- section 的顺序或 chapter 归属；
- section 之外的正文；
- 没有任何 section 的 bootstrap plan。

Harness 为它们计算独立的 `structureHash`。变化时，在同一 Update 消息中追加特殊结构项：

```markdown
## __plan-structure__

[Plan Structure Snapshot]

<当前完整结构表示>
```

结构表示是确定性的 plan skeleton：

- 原样保留所有不属于 section 范围的文本；
- 每个 section 用 `<!-- section: <id> -->` 占位；
- 占位顺序代表 canonical section 顺序；
- section heading 和正文仍由对应的 section snapshot/update 提供。

例如：

```markdown
# Project Plan

General constraints.

## Core

<!-- section: sec-core-interface -->
<!-- section: sec-errors -->

## Authentication

<!-- section: sec-refresh-token -->
```

这样 chapter、顺序和非 section 文本变化不需要重新发送所有 section 正文。

## 8. Diff 规则

Harness 解析当前 plan 为：

```ts
interface PlanCacheDocument {
  source: string;
  planHash: string;
  structureSource: string;
  structureHash: string;
  order: string[];
  sections: Map<string, {
    id: string;
    source: string;
    hash: string;
  }>;
}
```

section `source` 从 `###` heading 开始，到下一个 `###` section 或 `##` chapter 之前结束，保留空白、metadata 和完整正文。Hash 对原始 UTF-8 内容计算，不做 trim、换行归一化或 Markdown 重排。

比较最新 observed manifest 与磁盘状态：

- ID 只存在于当前 plan：新增，发送完整 section。
- ID 两边都存在但 hash 不同：修改，发送完整 section。
- ID 只存在于 observed manifest：删除，发送 tombstone。
- `structureHash` 不同：发送完整 structure snapshot。
- 所有 hash 相同：不产生消息。

一次检测到的 section 按当前 plan 顺序输出；删除项按旧 manifest 顺序输出，确保结果确定。

## 9. 生命周期

### 9.1 新 session 与恢复

`session_start` 扫描当前 branch 上最新的 Long Horizon Snapshot/Update custom message details：

- 找不到有效 manifest：读取当前完整 plan，准备建立首个 Snapshot。
- 找到 manifest：恢复 generation 和 observed hashes，然后读取磁盘并计算尚未记录的 delta。
- details 版本未知或损坏：不信任旧 manifest，建立新的完整 Snapshot，并给用户 warning。

首个 Snapshot 应在首个用户 prompt 之前写入 session；如果 session 启动时还没有有效 `plan.md`，则在第一次 `before_agent_start` 建立空/bootstrap Snapshot。

### 9.2 新用户 query

`before_agent_start` 再次读取 plan，以覆盖两次 query 之间由 Human、Agent、脚本或外部编辑器产生的变化。

如果有变化，通过 `BeforeAgentStartEventResult.message` 返回一条 hidden persistent Update，使它参与即将开始的 LLM 调用。该 hook 同时继续追加稳定 protocol system prompt。

### 9.3 Agent tool turn

`tool_result` 只标记“本 turn 可能需要重新检查 plan”，不立即生成 Update，避免连续 edit/write 产生多个中间版本。

`turn_end` 无条件允许读取一次当前 plan，并与 observed manifest 比较：

- 多个工具在同一 turn 修改同一 section，只追加最终版本；
- bash、custom tool 或外部进程造成的变化同样会被发现；
- 如果有 delta，使用 hidden custom message 以 `steer` 方式送入下一次自然 LLM call，不额外触发 turn。

### 9.4 Agent loop 结束

`agent_end` 做最后一次 diff。它覆盖 single completion、abort 或没有后续 LLM call 的情况。发现尚未持久化的 delta 时，使用 `pi.sendMessage(..., { triggerTurn: false })` 追加消息，供下一次用户 query 使用。

所有追加操作都以 observed plan hash 做去重；即使 `turn_end` 和 `agent_end` 连续执行，也只产生一次 Update。

### 9.5 Compaction

`session_before_compact` 继续调用 Pi 原生 compaction，并要求 summary 不复述完整 plan，因为 exact plan 会在压缩后重新建立。

只有收到成功的 `session_compact` 后才开始新 generation：

1. 重新读取当前 `plan.md`；
2. 追加新的完整 hidden Snapshot；
3. 将 observed manifest 更新为该 Snapshot；
4. 后续 delta 使用新的 `generationId`。

如果 compaction 失败、被取消或回退，不重置 generation，不追加新 Snapshot。

旧 Snapshot/Updates 若因 keep-recent 策略仍位于 compaction 后保留区，也会被新 Snapshot 整体覆盖，不影响语义。

## 10. Query Snapshot

当前 `[Long-Horizon Query Snapshot]` 保留：

- mode；
- active、attempts、done、blocker、tried、next；
- run section lock；
- Git HEAD、dirty、staged、conflicts；
- owned/unowned；
- recovery hints。

它在每个用户 query 的 `before_agent_start` 阶段只生成一次，后续 LLM 调用不通过 `context` hook 删除、移动或重建；工具结果负责传递 query 内状态变化。它不再重复 plan working set。为避免模型遗漏覆盖规则，稳定 protocol 增加：

```text
Plan Cached Snapshot is the baseline. For the same section ID, the latest Plan Update wins. A deleted tombstone removes all earlier versions.
```

## 11. 一致性与失败处理

- duplicate section ID 或 Git conflict marker 仍是 plan hard error；不生成增量，不推进 section。
- 缺失显式 ID 仍先 materialize，再建立 Snapshot/Update，避免基于临时 slug 的覆盖链。
- 持久消息追加失败时，不更新 observed manifest；下一次生命周期检查会重试同一 delta。
- 磁盘读取或解析失败时保留上一个有效 observed manifest，并在当前 Query Snapshot 中报告错误。
- Snapshot/Update 不是 Git ownership，不自动进入 section commit；canonical 变化仍由真实 `plan.md` 的 ownership 规则决定。
- 插件不根据来源或文件 mtime 判断变化，只信任解析后的原文 hash。

## 12. Cache 特性

与当前每次调用重建 working set 相比：

- 历史 Snapshot 和 Update 字节保持不变，provider 可复用更长的 prompt prefix；
- 每次小修改只增加一个完整 section，而不是重新发送整个 plan；
- 高频 progress/Git 变化位于尾部，不破坏此前 plan/conversation prefix；
- 成本是 compaction 周期开始时发送一次完整 plan，以及周期内保留被覆盖的旧 section 版本。

该策略最适合“大 plan、局部修改、长会话、provider 支持 prefix caching”的场景。若 plan 很小或会频繁整体重写，收益会下降，但语义仍正确。

## 13. 模块边界

新增的 diff 和消息渲染逻辑放入 host-agnostic core，例如：

```text
src/plan-cache.ts
```

它只负责 parse snapshot、hash、diff、render 和 manifest transition，不依赖 Pi。

`index.ts` 作为 Pi adapter 负责：

- 从 Pi session entries 恢复 manifest；
- 在 lifecycle hook 中调用 core；
- 使用 `BeforeAgentStartEventResult.message` 或 `pi.sendMessage()` 持久化 hidden message；
- 在 `session_compact` 后建立新 generation。

未来 Claude Code adapter 复用同一个 `plan-cache.ts`，只替换持久消息与 compaction lifecycle 的宿主接线。

## 14. 测试要求

Core 单元测试覆盖：

- 完整 section 正文切分和原始空白保留；
- 单 section、多 section、新增、删除和重复修改；
- ID 变化等价于 delete + add；
- structure skeleton 与 `__plan-structure__`；
- 输出顺序和 hash 的确定性；
- observed manifest transition 和重复检测去重。

Pi adapter 测试覆盖：

- 首个 query 前建立 Snapshot；
- query 之间的外部修改通过 `before_agent_start.message` 进入当前 call；
- 同一 turn 多次修改只产生最终 section Update；
- multi 模式 Update 在下一次自然 LLM call 前送达；
- single/abort 在 `agent_end` 后持久化但不触发额外 turn；
- session resume 从 message details 恢复且不重复发送；
- compaction 成功后追加新 Snapshot，失败或取消时不重置；
- tombstone 和 structure update 的真实消息格式；
- Query Snapshot 不再重复 plan working set，query 内状态变化通过工具结果传递。

Pi package/RPC smoke test继续确认插件通过独立 package manifest 加载，不修改 Pi 本体。
