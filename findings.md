# Findings

## Pi 0.73.1

- 本机验证入口：`pi`
- 兼容包：`@mariozechner/pi-coding-agent@0.73.1`
- Extension 自动发现目录：`~/.pi/agent/extensions/*.ts`、`~/.pi/agent/extensions/*/index.ts`、`.pi/extensions/*.ts`、`.pi/extensions/*/index.ts`
- TypeScript Extension 通过 jiti 加载，不需要预编译。
- 可用生命周期：`session_start`、`before_agent_start`、`context`、`tool_call`、`tool_result`、`agent_end`、`session_before_compact` 等。
- `context` 返回新的 `messages`，每次 LLM 调用前生效，适合动态注入 plan/progress/git。
- `ctx.abort()` 结束当前 agent loop，不关闭 Pi；`ctx.shutdown()` 才会退出 Pi。
- `pi.exec(command, args, options)` 可执行验证和 Git 命令，支持 cwd、timeout、AbortSignal。
- `pi.appendEntry()` 可保存 session 范围的 Extension 状态，适合保存 single/multi 模式。
- 自定义工具可设置 `executionMode: "sequential"`，避免 complete_section 与其他工具并行造成竞态。
- 自定义 compaction 可返回 `summary`、`firstKeptEntryId`、`tokensBefore` 和 `details`。

## 方案约束

- 不 fork `pi-agent-core`，不修改 Homebrew 安装包。
- 不在 `before_agent_start.message` 中永久注入动态状态；动态块放入 `context`。
- Git ownership 只覆盖 write/edit/delete/move；bash 产生的副作用不自动归属。
- single 完成后不发送 follow-up；multi 依赖下一次自然 LLM 调用读取更新后的 context。
- compaction 不复制完整 plan/progress/git 历史，只保存继续推理所需的 working memory。

## 实现与验证

- Pi 0.73.1 的 custom tool `terminate: true` 是跳过自动 follow-up LLM call 的标准机制；single completion 同时延迟调用 `ctx.abort()`，确保工具结果先返回。
- `OwnershipTracker` 在成功 write/edit/delete/move 后会清除同一路径的 unowned 标记。
- 每次 `before_agent_start` 创建新的 Run；同一 Run 内的 multi section history 保留在内存中，跨 query 不继承 completed section history。
- 发布前审查补充了符号链接越界保护、原子不覆盖 move、Run/progress/HEAD 一致性、multi section 基准更新、NUL Git status 解析和原生 compaction 回退。
- 最终验证：72 个 Vitest 测试通过，TypeScript 类型检查通过，Pi `--help` 加载通过，隔离安装后的 RPC `get_commands` 发现 `/lh`。
- 在干净临时目录执行 `npm ci`、`npm test`、`npm run typecheck` 均通过，公开仓库不再依赖本机 Homebrew 绝对路径。
- `npm audit --omit=dev` 的两个 high 告警来自兼容目标 `@mariozechner/pi-coding-agent@0.73.1` 的上游依赖；npm 建议的强制修复会降级到 0.49.3，因此未执行。
- 当前缓存实现已验证：95 个 Vitest 测试通过；snapshot/update 使用 hidden `custom_message`，manifest 含 `version`、`generationId`、`order`、完整 section hash；删除按旧 `order` 输出。
- `before_agent_start`、`turn_end`、`agent_end` 与 `session_compact` 共用串行 plan-cache queue；只有 `sendMessage()` 成功后才更新 observed manifest。
- malformed plan 不生成缓存消息而保留 stable protocol；缺失 section ID 在所有缓存生命周期入口先 materialize。

## 已验证的 API 细节

- `tool_result` 的输入路径字段与内置 write/edit 结果判定。
- `ctx.abort()` 延迟到自定义工具返回后，确保工具结果能写入 session。
- `pi.exec("git", ...)` 的返回码和超时行为。
- Pi 在 print/json 模式下的 UI 通知行为。
