# Long-Horizon Pi Extension 任务计划

## 目标

为 Pi 0.73.1 创建一个独立 Extension，把 plan.md、progress.md、Git 和原生 compaction 组合成可恢复的长周期工作流。

## 阶段

- [x] 探索 Pi 0.73.1 Extension API、文档和示例
- [x] 确认插件目录与 single/multi 运行语义
- [x] 完成设计确认
- [x] 写入设计文档并自检
- [ ] 编写实现计划
- [ ] 实现 plan/progress/context
- [ ] 实现 run、section 工具和 Git ownership
- [ ] 实现 compaction 与 `/lh` 命令
- [ ] 编写并运行测试
- [ ] 用 Pi 0.73.1 做加载和关键流程验证

## 当前阶段

设计文档已写入，等待用户审阅后进入实现计划。

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

