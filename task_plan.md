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

实现完成并通过单元测试、类型检查和 Pi 0.73.1 RPC 烟测。

## 实现结果

- `index.ts` 注册动态 context、Run 生命周期、compaction、`complete_section`、`reopen_section`、delete/move 和 `/lh`。
- `src/plan.ts` 解析 section、依赖和元数据，并为缺失 ID 做稳定 slug materialize。
- `src/progress.ts` 维护 bounded progress 状态和未知字段保留。
- `src/git.ts` 只选择本 Run owned 且非 pre-existing 的路径提交。
- `src/ownership.ts` 只在 write/edit 成功后确认 ownership；bash 副作用保留为 unowned。
- single 为默认模式；multi 通过 `/lh multi` 持续到 `/lh single`。
- single completion 的 abort 延迟到工具结果返回之后；Pi 工具结果同时返回 `terminate: true`。

## 验证结果

- `npm test`：8 个测试文件、46 个测试全部通过。
- `npm run typecheck`：通过。
- `/opt/homebrew/bin/pi -e ... --help`：Pi 0.73.1 成功加载扩展入口。
- RPC：`get_commands` 发现 `lh`；`/lh multi`、`/lh status`、`/lh single` 均成功执行。

## 当前限制

- 尚未在真实模型调用中运行完整项目任务；真实 verify 命令和自动 commit 已由注入式测试覆盖。
- 实现仍位于 `feat/long-horizon-extension` worktree，尚未合并到插件目录的 `main`。

## 已确认决策

- 源码目录：`/Users/zard/long-horizon-pi-extension`
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
