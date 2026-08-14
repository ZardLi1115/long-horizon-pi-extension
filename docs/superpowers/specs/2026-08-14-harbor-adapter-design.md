# Long-Horizon Harbor Adapter 设计

日期：2026-08-14  
目标：让 Harbor 能够在本地 task sandbox 中运行加载 Long Horizon 插件的 Pi。

## 1. 目标与边界

本适配层是一个独立的 Harbor 自定义 Agent，位于 Long Horizon Pi Extension 仓库内。它复用 Harbor 已有的 Pi agent 安装、模型连接、日志、超时、token/cost 统计和 verifier 流程，只改变 Pi 的启动命令，使 Pi 显式加载当前本地 checkout 中的 `index.ts`。

第一版只支持专门的 long-horizon task。每个 task 必须自行提供：

```text
plan.md
progress.md
task.toml
instruction.md
environment/
tests/
```

适配层不生成、改写或上传 `plan.md` / `progress.md`，也不实现原生 Pi 对照实验。用户后续可以直接使用 Harbor 的原生 `pi` agent 作为未启用插件的运行方式。

适配层不做以下事情：

- 不修改 Harbor 源码、AgentFactory 或全局安装包；
- 不在运行时访问 GitHub、npm registry 或其他远程源来获取 Long Horizon；
- 不自动创建 plan、progress 或 Git 仓库；
- 不负责 benchmark 数据集转换；
- 不改变 Long Horizon TypeScript core 和 Pi Extension API。

## 2. 运行模型

Harbor 从当前仓库导入自定义 Agent：

```text
harbor run
  --agent harbor_adapter.agent:LongHorizonPi
  --model <provider/model>
  --task <long-horizon-task>
```

`LongHorizonPi` 继承 Harbor 的内置 Pi agent。Harbor 仍然负责：

1. 构建 task environment；
2. 安装 Node 和 Pi；
3. 注入模型认证信息；
4. 调用 agent 的 `setup()` / `run()`；
5. 同步 `/logs`；
6. 执行 task verifier 并收集 reward。

适配层只增加两件事：

1. 在 setup 阶段确认 task 的 `plan.md` 和 `progress.md` 存在，并将本地插件运行所需文件上传到 sandbox；
2. 在 Pi 命令中增加 `--no-extensions --extension <staged>/index.ts`。

```text
本地 Long Horizon checkout
        │ 只上传 index.ts、package.json、src/**/*.ts
        ▼
Harbor task sandbox
        │
        └── pi --print --mode json --no-extensions \
              --extension /tmp/long-horizon-pi-extension/index.ts \
              ... task instruction
```

`--no-extensions` 防止 sandbox 中已有的用户级 Pi extension 影响实验；显式 `--extension` 仍然加载目标插件。Pi 的 session、JSON 输出、日志文件和 token/cost 解析沿用 Harbor 内置 Pi agent 的行为。

## 3. 文件与职责

```text
harbor_adapter/
├── __init__.py
├── agent.py
├── staging.py
├── command.py
├── README.md
└── tests/
    ├── test_command.py
    └── test_staging.py
```

### `harbor_adapter/agent.py`

定义 `LongHorizonPi`：

- 继承 Harbor 的 `Pi` agent，复用 Pi 安装和 `populate_context_post_run()`；
- `setup()` 先执行父类 setup，再校验 task artifacts 和 staging 本地插件；
- `run()` 复制 Harbor Pi agent 当前的模型/env/session/log 参数拼装逻辑，只插入 `--no-extensions` 与 `--extension`；
- 继续使用 `/logs/agent/pi/pi.txt`，不改变 Harbor 对 JSON 输出和 usage 的解析；
- `name()` 返回独立名称，例如 `long-horizon-pi`，避免和 Harbor 原生 `pi` 名称混淆；
- `version()` 返回 Pi 版本或适配层版本，具体采用父类可用的版本信息。

### `harbor_adapter/staging.py`

负责定位和上传本地 checkout 的运行时文件：

- 通过 `Path(__file__)` 定位当前 Long Horizon 仓库根目录；
- 要求根目录存在 `index.ts` 和 `src/`；
- 只允许上传 `index.ts`、`package.json`（如存在）和 `src/**/*.ts`；
- 明确排除 `.git`、`node_modules`、测试、文档和规划文件，避免把开发环境或本地记录带入 sandbox；
- 使用 Harbor `BaseInstalledAgent._upload_agent_owned_file()` 上传，确保 agent 用户可读取；
- 返回固定的 sandbox root，供命令构造器生成绝对 extension 路径。

适配层不通过 `git clone`、`npm install` 或 `pi install` 取得插件。Pi 自身的依赖由 Harbor 内置 Pi agent 安装；Long Horizon 只作为本地 TypeScript extension 源码被显式加载。

### `harbor_adapter/command.py`

提供不依赖 Harbor runtime 的纯函数，用于生成和测试 Pi 命令中的插件参数。它接收：

- instruction；
- provider/model 参数；
- Pi session/log 参数；
- staged extension path；
- resume、thinking 等父类 Pi 选项。

它必须保证所有来自 task、模型和路径的字符串经过 shell quoting，且生成结果包含：

```text
--no-extensions
--extension <quoted staged index.ts>
```

### `harbor_adapter/README.md`

说明：

- 本地 checkout 约定；
- Harbor import path 的运行命令；
- task 目录最低要求；
- 如何使用原生 `pi` agent 做未启用插件的运行；
- Harbor 未安装在当前开发机时，如何在装有 Harbor 的环境中执行 smoke test；
- 明确适配层不会联网拉取插件。

## 4. Setup 与运行细节

### 4.1 Setup 校验

setup 阶段失败必须给出可定位错误：

- `plan.md` 缺失：提示 task 必须携带 canonical plan；
- `progress.md` 缺失：提示 task 必须携带 execution progress；
- 本地 checkout 缺少 `index.ts` 或 `src/`：提示应从完整 Long Horizon 仓库根目录运行；
- 任一允许上传文件失败：保留 Harbor 原始错误并指明文件路径。

校验只读 task 文件，不会自动补文件或改写内容。Long Horizon 自身在 Pi 运行时对缺少 section ID 的既有行为保持不变。

### 4.2 Pi 命令

`LongHorizonPi.run()` 复用 Harbor 当前 Pi agent 的：

- model connection 和 provider env；
- `--print --mode json`；
- `/logs/agent/pi/sessions`；
- `--continue` resume 行为；
- `--thinking` 及其他已支持 CLI flags；
- stdout/stderr tee 到 `/logs/agent/pi/pi.txt`。

仅增加：

```text
--no-extensions --extension <staged-root>/index.ts
```

如果 Pi 返回非零退出码，直接沿用 Harbor agent 的异常和 trial 失败处理，不把错误转换成 reward。

## 5. 错误与安全边界

- 本地插件路径由 adapter 文件位置确定，不接受 task instruction 里的路径，避免模型控制加载任意宿主文件。
- staging 使用固定 allowlist，不上传 `node_modules`、`.git`、隐藏文件或规划记录。
- task 的 `plan.md` / `progress.md` 只做存在性检查；schema、Git、verify 和 ownership 由 Long Horizon runtime 负责。
- adapter setup 失败时不启动 Pi，避免得到一个实际上未加载插件的假阳性 trial。
- `--no-extensions` 确保未意外加载其他 Pi 用户扩展；目标插件通过绝对路径显式加载。
- 本适配层不执行网络命令。另一台电脑运行时必须提前将本仓库下载到本地，并从该 checkout 导入 `harbor_adapter.agent:LongHorizonPi`。

## 6. 测试策略

测试分为不需要 Harbor 安装的单元测试和需要 Harbor sandbox 的 smoke test。

### 单元测试

- 命令构造包含 `--no-extensions` 和正确的 `--extension` 路径；
- instruction、路径、模型名中的 shell 特殊字符被正确 quoting；
- staging allowlist 包含 `index.ts`、`src/**/*.ts`，排除 `node_modules`、`.git`、tests 和规划文件；
- 缺少 `index.ts` 或 `src/` 时给出明确错误；
- task 缺少 `plan.md` 或 `progress.md` 时 setup 校验失败。

### Harbor smoke test

在装有 Harbor、Docker 和可用模型认证的环境中：

1. 用最小 long-horizon task 启动 `LongHorizonPi`；
2. 检查 agent 日志中 Pi 命令加载了 staged `index.ts`；
3. 检查 task verifier 仍然执行并写出 reward；
4. 检查 `/logs/agent/pi/pi.txt` 能被父类 usage parser 解析；
5. 用 Harbor 原生 `pi` agent 运行同一 task 时，不要求 adapter 参与。

当前 Mac 没有安装 Harbor CLI，因此设计阶段只运行 TypeScript 基线测试；实现阶段至少运行 Python 语法/单元测试，并在可用 Harbor 环境中执行 smoke test。没有 Harbor runtime 时，不声称 smoke test 已通过。

## 7. 成功标准

- 从 Long Horizon checkout 根目录可通过 Harbor import path 加载 `LongHorizonPi`；
- task 缺少 `plan.md` 或 `progress.md` 时在 Pi 启动前明确失败；
- Pi 只加载本地 staging 的 Long Horizon extension，不访问远程源；
- Harbor 原生日志、verifier、reward、token 和 cost 流程不被破坏；
- 用户可以用 Harbor 内置 `pi` agent 运行同一 task，adapter 不强制参与对照实验；
- 本次实现不修改 Harbor 源码、Pi 安装包或 Long Horizon TypeScript core。
