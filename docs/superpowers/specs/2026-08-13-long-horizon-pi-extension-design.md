# Long-Horizon Pi Extension 设计

日期：2026-08-13  
目标版本：Pi 0.73.1  
源码目录：独立 `long-horizon-pi-extension` 仓库

## 1. 目标与边界

这个 Extension 为 Pi Coding Agent 增加长周期项目执行协议：每次模型调用前从磁盘重新读取 canonical plan/progress/Git 状态，把动态状态临时注入 context；section 完成由自定义工具触发验证、状态更新和 Git 提交；compaction 只保存当前继续推理需要的工作记忆。

实现不 fork `pi-agent-core`，不修改 Homebrew 安装包。插件源码独立维护，开发验证使用 `pi -e`，稳定后再链接到 `~/.pi/agent/extensions/`。

本设计的保守边界：

- `plan.md`、`progress.md` 和 Git 只读取当前 Pi `cwd`，不向父目录查找。
- v1 要求当前 `cwd` 已经是 Git 仓库；不是 Git 仓库时只报告不可用，不自动执行 `git init` 或 baseline commit。
- bash 的文件副作用不自动归属到 agent；只有 write/edit/delete/move 纳入 ownership。
- 默认模式为 `single`。

## 2. 运行模式与 Run 生命周期

### 2.1 single 模式

`single` 是默认模式。一次用户 query 创建一个 Run，并锁定 query 开始时的 `progress.active`。

```text
user query
  -> before_agent_start 读取并锁定 active section
  -> 多轮 LLM/tool 调用
  -> complete_section(current section)
  -> 可选 verify
  -> 更新 progress.md
  -> 提交本 Run 的 owned paths
  -> 延迟 ctx.abort()
  -> agent_end，等待下一条用户 query
```

完成后不发送 `sendUserMessage`、`followUp` 或 `steer`，因此不会自动进入下一个 section。`ctx.abort()` 只停止当前 agent loop，Pi 仍保持运行。

如果模型没有调用 `complete_section`，或者验证失败，则不结束 Run；已有修改保留为工作区脏改动，并在 `agent_end`/context 中报告。

### 2.2 multi 模式

执行 `/lh multi` 后，模式在当前 Pi session 中持续生效，直到执行 `/lh single`。当前 session 没有模式记录时默认 `single`。

在 `multi` 模式中，每个 section 仍然是一个独立的语义提交单元，但完成后不调用 `ctx.abort()`：

```text
complete_section(sec-a)
  -> verify
  -> progress.active = sec-b
  -> commit agent(sec-a): ...
  -> 下一次 LLM 调用通过 context 看到 sec-b
```

这样一次 query 可以连续完成多个 section，同时每个 section 仍可单独回滚和审计。

### 2.3 Run 状态

Extension 内存中维护当前 Run：

```ts
interface RunState {
  runId: string;
  mode: "single" | "multi";
  startedAt: string;
  sectionId: string;
  baseHead: string | null;
  preexistingDirtyPaths: string[];
  pendingPaths: Map<string, string>;
  ownedPaths: Set<string>;
  unownedPaths: Set<string>;
  completedSections: string[];
  completed: boolean;
}
```

`single` 中 `sectionId` 在整个 query 内不变。`multi` 中 section 完成后切换到新的 `progress.active`，但仍保留同一个 query 的 Run 统计。

## 3. `/lh` 斜杠指令

注册一个命令：

```text
/lh single   # 切换为 single
/lh multi    # 切换为 multi
/lh status   # 显示当前模式、active section 和 Git 状态
```

模式写入 Pi session custom entry：

```ts
pi.appendEntry("long-horizon/mode", { mode: "single" | "multi" });
```

`session_start` 时扫描当前 session 的最新 entry 恢复模式。模式切换不修改 `plan.md` 或 `progress.md`，也不创建 Git commit。

## 4. Plan 解析与 Context

### 4.1 plan.md 格式

一级 `##` 为 chapter，`###` 为 section。section 元数据采用 HTML comment：

```markdown
### 3.2 Refresh Token Flow
<!-- id: sec-refresh-token -->
<!-- needs: sec-auth-api, sec-user-schema -->
<!-- verify: npm test -- test/auth -->
<!-- brief: 刷新令牌轮换与重放失效 -->
```

解析器支持 `id`，并兼容 `section-id` 作为别名。显示编号不是状态主键，section ID 一旦存在不得因标题或编号变化而改变。

### 4.2 异常行为

- 缺少 ID：从标题生成稳定 slug，写回 `plan.md`；操作幂等，并记录为插件 owned path。
- ID 重复：判定为硬错误；禁止 `complete_section` 推进，context 注入修复提示。
- `progress.active` 不存在：不猜测，注入 recovery hint，要求模型或用户选择有效 ID。
- `plan.md` 含 Git conflict marker：拒绝正常解析，注入冲突片段和修复提示。
- `plan.md` 不存在或没有 section：进入 bootstrap context；`complete_section` 返回错误。

### 4.3 动态 context

`context` hook 在每次 LLM 调用前读取最新：

- plan context：小计划完整注入；大计划注入 chapter index、active section 前后邻居和 `needs` 一跳依赖；不做模型摘要。
- progress：active、done、attempts、blocker、tried、next。
- Git：HEAD、当前工作区状态、Run owned/unowned paths、plan 是否变化。
- hints：bootstrap、重复 ID、active 缺失、验证失败、stuck attempts、single/multi 规则。

动态块作为隐藏 custom message 返回，不永久追加到 session history。稳定协议通过 `before_agent_start` 的 system prompt 追加一次性规则：plan 是 roadmap，progress 是 pointer，Git 是代码历史，完成必须调用 section 工具。

每次 Run 开始时 harness 更新 attempts：active 未变化则递增，active 变化则重置为 1；切换 active 时清空 section 局部 `tried`，blocker 由完成或验证失败流程覆盖。

## 5. Progress 文件

`progress.md` 是覆盖式状态，不是历史日志：

```yaml
active: sec-refresh-token
attempts: 3

done:
  - sec-project-structure
  - sec-auth-api

blocker:
  - refresh race remains

tried:
  - optimistic lock -> deadlock under load

next:
  - fix race
  - run auth tests
```

解析器只承诺处理上述有界字段；未知字段在写回时保留或明确报告，不能静默解释为状态。文件不存在或无法解析时，在内存中构造空状态并以第一个未完成 section 作为 active；在需要持久化时写出规范格式。

## 6. Section 工具

### 6.1 complete_section

工具参数：

```ts
{
  id: string,
  verify?: string,
  note?: string
}
```

执行规则：

1. `id` 必须等于当前 Run 锁定的 section；single 不允许跨 section 完成。
2. 如果提供 `verify`，在当前 cwd 执行 shell 命令；exit code 为 0 才通过。未提供则标记为 `unverified`，不强制执行 plan 元数据中的命令。
3. 验证失败：active 保持不变，attempts 增加，输出尾部截断后写入 blocker；不更新 done，不提交，不结束 Run。
4. 验证通过：将 id 放入 done，active 推进到下一个未完成 section，重置 attempts，清空 blocker，并写回 progress.md。
5. 将 progress.md、插件本 Run 明确 owned 的文件加入一次 Git commit；commit message 包含 section ID。
6. single 模式下记录完成结果并延迟 `ctx.abort()`，确保 tool result 有机会进入 Pi session；multi 模式继续下一次 LLM 调用。

工具使用 `executionMode: "sequential"`，防止同一 assistant 消息并行执行多个 section 状态变更。

### 6.2 reopen_section

参数：`{ id: string, reason?: string }`。

将已完成 ID 从 done 移回 active，清空该 section 的完成状态并写入 blocker/next 提示。它不自动回滚 Git，也不删除历史 commit；代码回滚通过 Git 工具完成。`reopen_section` 只允许在当前 Run 空闲或明确指向已有 done section 时执行，避免并行状态竞态。

### 6.3 delete / move

Pi 没有内置 delete/move，因此注册两个 Extension tool：

- `long_horizon_delete(path)`：删除单个文件；拒绝 `.git` 和 cwd 外路径。
- `long_horizon_move(from, to)`：移动单个文件；拒绝 cwd 外路径和覆盖已有目标。

成功执行后把源/目标路径登记为 owned；失败只返回错误，不登记 ownership。

## 7. Git ownership 与提交

Run 开始时记录 `baseHead`、预先 dirty/staged paths。write/edit 在 `tool_call` 阶段记录 pending path，在成功 `tool_result` 后加入 owned paths；delete/move 由工具执行成功后加入。

Git 提交只使用：

- 本 Run 成功 write/edit/delete/move 触碰的、启动时未脏的路径；
- 插件本次更新的 `plan.md`、`progress.md`。

bash 造成的文件变化保留为 unowned dirty change，不自动加入提交。预先 dirty/staged 的路径不纳入自动提交；如果 agent 同时触碰这些路径，`complete_section` 报告边界不明确并拒绝声称已完成，除非这些路径被明确清理或后续实现增加人工 ownership 确认。

提交前检查：

- 当前 cwd 是 Git 仓库；
- 没有 conflict marker；
- owned 路径仍存在预期差异；
- 没有把预先 staged/dirty 或 unowned 路径加入 commit。

没有可提交代码时，工具返回明确的 `no changes to commit`，但 progress 的语义更新仍然保留并报告。

## 8. Compaction

`session_before_compact` 返回自定义 compaction：

```text
## Execution Position
active: ...
mode: single|multi
plan_source: plan.md

## Working Memory
<generated summary of implementation decisions, debug state, blockers, open questions and next reasoning>
```

生成摘要时要求模型不要复述完整 plan、progress 或 Git 历史；这些信息在下一次 `context` hook 中从磁盘重建。`details` 保存：

```ts
{
  compactedAtHead: string | null,
  active: string | null,
  mode: "single" | "multi",
  planHash: string | null
}
```

如果当前 model 或认证不可用，放弃 Extension 自定义摘要，让 Pi 使用原生 compaction，并发出 warning；不阻塞用户继续工作。

## 9. 错误与恢复

- 没有 Git：context 显示 Git unavailable，section 工具拒绝自动提交。
- active 缺失：禁止推进，要求修复 plan/progress 关系。
- 重复 ID：禁止推进，完整注入 plan 并要求修复。
- verify 非零：保留 active，记录有界 blocker，Run 继续。
- 工具执行失败：不登记 ownership，不更新完成状态。
- query 自然结束但未完成：保留工作区修改，agent_end 报告 owned/unowned/uncommitted 路径。
- Pi session 恢复：模式从 session entry 恢复；active/done/blocker 从当前 cwd 文件恢复；Run 内存状态重新开始，不依赖旧对话。

## 10. 测试与验收

### 单元测试

- section ID 读取、自动补 ID、重复 ID、conflict marker。
- needs/verify/brief 元数据解析。
- progress 有界字段读写、active 推进、attempts、done/reopen。
- plan working set 和 context block 稳定输出。
- Git status 中 pre-existing、owned、unowned 路径分类。
- verify 通过/失败和命令输出截断。

### Pi 集成烟测

- `pi -e <repo>/index.ts` 能加载无 TypeScript 错误。
- `/lh status` 默认显示 single。
- `/lh multi`、`/lh single` 可切换且 session resume 后保持。
- single 完成后只触发一次当前 query 的 `agent_end`，不自动发送下一条 user message。
- multi 完成一个 section 后下一次 context 看到新的 active。
- compaction entry 含 Extension details，且 summary 不复制完整 plan。

### 验收标准

1. 不修改 Pi Homebrew 安装包即可加载插件。
2. 每次 LLM 调用都能看到当前磁盘 plan/progress/Git 状态。
3. single/multi 行为与本设计一致。
4. 验证失败不会错误推进或提交。
5. 用户已有脏改动和 bash 副作用不会被自动提交。
6. 测试和真实 Pi 加载烟测通过。

## 11. 非目标

- Pi core fork。
- provider-specific 显式 prompt cache breakpoint。
- 小模型 chapter summary cache。
- dependency graph 传递闭包。
- 完整 acceptance engine、多 agent 冲突解决和 bash ownership 推断。
- 自动 Git 初始化、baseline commit 和人工 approval gate。
