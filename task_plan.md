# Long-Horizon Pi Extension 任务计划

## 目标

为 Pi 0.73.1 创建一个独立 Extension，把 plan.md、progress.md、Git 和原生 compaction 组合成可恢复的长周期工作流。

## 阶段

- [x] 探索 Pi 0.73.1 Extension API、文档和示例
- [x] 确认插件目录与 single/multi 运行语义
- [x] 完成设计确认
- [x] 写入设计文档并自检
- [x] 编写实现计划
- [x] 实现 plan/progress/context
- [x] 实现 run、section 工具和 Git ownership
- [x] 实现 compaction 与 `/lh` 命令
- [x] 编写并运行测试
- [x] 用 Pi 0.73.1 做加载和关键流程验证

## 当前阶段

实现完成并进入发布前验证；当前分支已包含 plan snapshot/delta cache、tombstone、structure update、session resume 与 compaction generation。

## 实现结果

- `index.ts` 注册动态 context、Run 生命周期、compaction、`complete_section`、`reopen_section`、delete/move 和 `/lh`。
- `src/plan.ts` 解析 section、依赖和元数据，并为缺失 ID 做稳定 slug materialize。
- `src/progress.ts` 维护 bounded progress 状态和未知字段保留。
- `src/git.ts` 只选择本 Run owned 且非 pre-existing 的路径提交。
- `src/ownership.ts` 只在 write/edit 成功后确认 ownership；bash 副作用保留为 unowned。
- single 为默认模式；multi 通过 `/lh multi` 持续到 `/lh single`。
- single completion 的 abort 延迟到工具结果返回之后；Pi 工具结果同时返回 `terminate: true`。
- plan cache 在 generation 开始时追加完整 hidden snapshot；query/turn/agent_end 只追加最新 section、删除 tombstone 或 `__plan-structure__`。
- session resume 从 hidden custom message details 恢复完整 manifest；成功 compaction 后追加新的 generation snapshot。

## 验证结果

- `npm test`：10 个测试文件、95 个测试全部通过（plan-cache 与 Pi adapter 回归已包含）。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- `npm pack --dry-run`：package manifest、源码、测试和文档均进入 tarball。
- `pi -e <repo>/index.ts --help`：Pi 0.73.1 成功加载扩展入口。
- 隔离 Pi package 安装：`pi install <local-repo>` 成功，RPC `get_commands` 从 package manifest 发现 `lh`。
- 干净临时目录：待本轮最终 diff 固定后重新执行 `npm ci`、`npm test`、`npm run typecheck`。

## 当前限制

- 尚未在真实模型调用中运行完整项目任务；真实 verify 命令和自动 commit 已由注入式测试覆盖。
- npm 对兼容目标 Pi 0.73.1 的上游依赖报告两个 high 告警；强制修复会破坏版本兼容，等待后续适配 `@earendil-works/pi-coding-agent` 新版本时处理。

## 已确认决策

- 源码目录：独立 `long-horizon-pi-extension` 仓库
- 默认模式：`single`
- `/lh multi` 持续到 `/lh single`
- single：一次 query 一个 section，完成后结束当前 agent loop
- multi：一次 query 可连续完成多个 section，每个 section 独立验证和提交
- verify 命令由 `complete_section` 显式传入，可不传
- 未调用 `complete_section` 的请求保留脏改动，并在结束时报告
- plan/progress 默认只读取当前 cwd
- v1 要求当前 cwd 已经是 Git 仓库，不自动初始化 Git

## 遇到的错误

| 错误 | 次数 | 处理 |
|---|---:|---|
| 默认模式下无法调用 `request_user_input` | 多次 | 改用普通对话确认，未影响设计推进 |
