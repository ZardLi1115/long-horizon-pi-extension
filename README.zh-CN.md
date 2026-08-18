<p align="center">
  <img src="./assets/long-horizon-pi-extension-icon.png" width="320" alt="Long Horizon Pi Extension 视觉图：分阶段计划块位于可恢复工作流循环中">
</p>

<h1 align="center">Long Horizon Pi Extension</h1>

<p align="center">为 <a href="https://github.com/badlogic/pi-mono">Pi Coding Agent</a> 提供可恢复、按计划章节执行的工作流。</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="./package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D20.6-3776AB?style=flat-square" alt="Node.js 20.6 或更高版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" alt="MIT 许可证"></a>
</p>

Long Horizon 是一个独立的 Pi 扩展，面向跨多个步骤或会话的编程任务。它将 `plan.md`、`progress.md` 和 Git 作为项目的规范状态，锁定当前计划章节，记录具体失败尝试，并可提交已完成章节所拥有的文件变更。

## 核心能力

| 能力 | 作用 |
| --- | --- |
| **按章节执行** | 默认每次 Pi 查询只处理一个活动计划章节；`/lh multi` 可在一次查询中处理多个章节，同时为每个章节保留独立的完成边界。 |
| **可恢复状态** | 每次查询开始时重新读取 `plan.md`、`progress.md` 和 Git 状态，而不是只依赖临时的对话上下文。 |
| **明确的恢复信号** | 通过 `record_attempt_failure` 记录一个已失败或被放弃的具体方案；重新打开已完成章节不会改写 Git 历史。 |
| **按所有权提交变更** | 章节完成时，仅选择当前运行拥有的文件与运行时写入的状态进行自动 Git 提交，不会无差别提交无关的脏文件。 |
| **计划感知的压缩** | 保存 `plan.md` 的隐藏快照，并在压缩之间仅追加发生变化的章节。 |

## 运行要求

- Node.js `>=20.6.0`
- Pi Coding Agent `0.73.1`（仓库的开发依赖版本）
- 若要在章节边界自动提交，则需要在 Git 仓库中运行

> **安装说明：** Pi 安装 Git 包时只安装生产依赖。当前仓库将所需的运行时包声明在 `devDependencies` 中，因此 `pi install https://github.com/ZardLi1115/long-horizon-pi-extension` **不是**此版本支持的安装方式。请使用本地检出配合 `npm install`。

## 快速安装

```bash
git clone https://github.com/ZardLi1115/long-horizon-pi-extension.git
cd long-horizon-pi-extension
npm install
```

扩展检出目录可以与实际使用它的 Git 项目分开存放。

## 快速开始

1. 在希望让 Pi 操作的 Git 项目中创建 `plan.md` 与 `progress.md`。

   ```markdown
   <!-- plan.md -->
   # Feature plan

   ### Add account settings
   <!-- id: account-settings -->
   <!-- verify: npm test -->

   Implement and test the account settings workflow.
   ```

   ```yaml
   # progress.md
   active: account-settings
   attempts: 0

   done:

   blocker:

   tried:

   next:
   ```

2. 从该项目启动 Pi，并显式加载本地扩展。

   ```bash
   cd /absolute/path/to/your-git-project
   pi --extension /absolute/path/to/long-horizon-pi-extension/index.ts
   ```

3. 让 Pi 实现当前活动章节。扩展会向智能体提供当前计划、进度与 Git 快照。工作准备完成后，Pi 会使用 `complete_section` 验证该章节、更新 `progress.md`，并在 Git 可用时提交本次运行拥有的变更。

如果 `progress.md` 未设置 `active`，扩展会选择未列入 `done` 的第一个计划章节。

## 计划与进度文件

Long Horizon 将三级 Markdown 标题（`###`）识别为计划章节。建议为每个章节添加显式 ID，使其在编辑后仍保持稳定；当 ID 缺失时，扩展可根据标题生成并写入 ID。

```markdown
## Authentication

### Add session refresh
<!-- id: session-refresh -->
<!-- needs: session-storage -->
<!-- verify: npm test -->
<!-- brief: Refresh an expiring user session safely. -->
```

支持的章节元数据：

| 元数据 | 用途 |
| --- | --- |
| `id` 或 `section-id` | 章节的稳定标识符。 |
| `needs` | 依赖章节 ID 的逗号分隔列表。 |
| `verify` | 当 `complete_section` 未传入其他验证命令时默认执行的 shell 命令。 |
| `brief` | 附加到已解析章节的可选简短描述。 |

`progress.md` 是一个轻量的 YAML 风格状态文件。它支持的字段为 `active`、`attempts`、`done`、`blocker`、`tried` 和 `next`。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/lh status` | 显示当前模式、活动章节、尝试次数、Git 状态以及当前运行的文件所有权状态。 |
| `/lh single` | 使用默认模式：一次用户查询锁定一个活动章节，成功完成后结束该智能体循环。 |
| `/lh multi` | 允许同一次查询继续处理后续章节；每个完成的章节仍有独立的提交边界。 |

所选模式会作为 Pi 会话数据保存，不会修改 Pi 的全局配置。

## 工作流工具

| 工具 | 用途 |
| --- | --- |
| `complete_section(id, verify?, skipVerify?, note?)` | 完成当前锁定章节。除非显式设置 `skipVerify: true`，否则会运行传入或计划中定义的验证命令；随后更新 `progress.md` 并尝试进行范围受限的 Git 提交。 |
| `record_attempt_failure(id, tried, blocker, next)` | 为活动章节记录一个具体失败或被放弃的方案。普通智能体回合和验证失败不会自动增加 `attempts`。 |
| `reopen_section(id, reason?)` | 将已完成章节重新设为活动章节，但不改写 Git 历史。 |
| `long_horizon_delete(path)` | 删除当前项目中的一个文件，并将其登记为本次运行拥有的文件。 |
| `long_horizon_move(from, to)` | 在当前项目中移动一个文件，不覆盖目标文件，并将两个路径登记为本次运行拥有的文件。 |

该扩展替换了 Pi 的 `write` 与 `edit` 实现，以便验证所有文件路径均位于当前工作目录内。提交前，它还会检查先前拥有的内容是否被其他进程改动。

## Git 边界与恢复

每次用户查询开始时，Long Horizon 都会读取规范的 `plan.md`、`progress.md` 和 Git 状态。成功完成章节时，它会写入下一阶段的进度状态，并尝试提交当前运行拥有的文件以及运行时写入的状态（例如 `progress.md`）。未由当前运行获取所有权的脏文件会被报告为未拥有，且不会包含在自动提交中。

若一次运行未完成，扩展会报告活动章节、已拥有与未拥有的路径，以及当前脏路径，以便下一次查询从已记录状态恢复。

## 架构

```text
assets/          README 项目视觉资源
src/             宿主无关的工作流核心
tests/           核心逻辑与 Pi 接线测试
index.ts         Pi Extension API 适配器
harbor_adapter/  可选的本地 Harbor 适配器、指南与 Python 测试
```

Pi 适配器负责宿主集成。计划解析、进度追踪、运行所有权、Git 事务、文件系统操作与计划缓存都位于 `src/`，因此其他宿主适配器可以复用这套工作流核心。

## 可选 Harbor 适配器

仓库提供一个受支持的可选本地 Harbor 自定义智能体适配器，可在 Harbor 的 Pi 智能体中从本地检出目录加载本扩展。其运行要求和命令请参阅 [Harbor 适配器指南](./harbor_adapter/README.md)。

## 开发

```bash
npm test
npm run typecheck
```

## 许可证

本项目采用 [MIT License](./LICENSE)。
