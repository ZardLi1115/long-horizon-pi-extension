# Harbor Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only Harbor custom Agent that runs Harbor's Pi agent with the Long Horizon extension explicitly loaded, without modifying Harbor or fetching the plugin remotely.

**Architecture:** Add a small Python `harbor_adapter` package beside the existing TypeScript extension. The adapter subclasses Harbor's built-in `Pi` agent, stages only the local runtime TypeScript files into the Harbor sandbox, validates that `plan.md` and `progress.md` already exist in the task working directory, and adds `--no-extensions --extension <staged>/index.ts` to Pi's command. Pure command/staging helpers are independent of the Harbor runtime so they can be tested on this Mac without installing Harbor.

**Tech Stack:** Python 3.12+, Harbor 0.21-compatible `BaseInstalledAgent`/Pi APIs, Python standard library `unittest`, existing TypeScript/Vitest project.

---

## Task 1: Add and test pure command/staging helpers

**Files:**
- Create: `harbor_adapter/__init__.py`
- Create: `harbor_adapter/command.py`
- Create: `harbor_adapter/staging.py`
- Create: `harbor_adapter/tests/__init__.py`
- Create: `harbor_adapter/tests/test_command.py`
- Create: `harbor_adapter/tests/test_staging.py`

- [ ] **Step 1: Add package markers**

Create empty `harbor_adapter/__init__.py` and `harbor_adapter/tests/__init__.py`. Do not import Harbor from `__init__.py`, so pure tests work without Harbor installed.

- [ ] **Step 2: Write the failing command tests**

Create `harbor_adapter/tests/test_command.py`:

```python
import shlex
import unittest

from harbor_adapter.command import build_pi_command


class BuildPiCommandTests(unittest.TestCase):
    def test_includes_explicit_long_horizon_extension_and_disables_discovery(self):
        command = build_pi_command(
            instruction="fix the parser",
            provider="anthropic",
            model="claude-sonnet-4-5",
            extension_path="/tmp/long horizon/index.ts",
            resume=False,
            cli_flags="",
        )

        self.assertIn("--no-extensions", command)
        self.assertIn("--extension '/tmp/long horizon/index.ts'", command)
        self.assertIn("--provider anthropic", command)
        self.assertIn("--model claude-sonnet-4-5", command)
        self.assertTrue(
            command.endswith(
                "'fix the parser' 2>&1 </dev/null | "
                "grep -v '\"type\":\"message_update\"' | "
                "stdbuf -oL tee /logs/agent/pi/pi.txt"
            )
        )

    def test_quotes_instruction_and_runtime_values_as_single_shell_words(self):
        command = build_pi_command(
            instruction="fix; echo SHOULD_NOT_RUN",
            provider="open ai",
            model="model's id",
            extension_path="/tmp/with space/index.ts",
            resume=True,
            cli_flags="--thinking high",
        )

        self.assertIn("--continue", command)
        self.assertIn("--provider 'open ai'", command)
        self.assertIn("--model " + shlex.quote("model's id"), command)
        self.assertIn("'fix; echo SHOULD_NOT_RUN'", command)
        self.assertIn("--thinking high", command)
```

- [ ] **Step 3: Run the command tests and verify RED**

Run:

```bash
/Users/zard/.venvs/test/bin/python -m unittest harbor_adapter.tests.test_command -v
```

Expected: collection fails with `ModuleNotFoundError: No module named 'harbor_adapter.command'`.

- [ ] **Step 4: Implement the minimal command builder**

Create `harbor_adapter/command.py`:

```python
from __future__ import annotations

import shlex


def build_pi_command(
    *,
    instruction: str,
    provider: str,
    model: str,
    extension_path: str,
    resume: bool,
    cli_flags: str,
    session_dir: str = "/logs/agent/pi/sessions",
    output_file: str = "/logs/agent/pi/pi.txt",
) -> str:
    parts = [
        "pi",
        "--print",
        "--mode",
        "json",
        "--session-dir",
        shlex.quote(session_dir),
    ]
    if resume:
        parts.append("--continue")
    parts.extend(
        [
            "--no-extensions",
            "--extension",
            shlex.quote(extension_path),
            "--provider",
            shlex.quote(provider),
            "--model",
            shlex.quote(model),
        ]
    )
    if cli_flags:
        parts.append(cli_flags)
    parts.append(shlex.quote(instruction))
    return (
        ". ~/.nvm/nvm.sh; "
        + " ".join(parts)
        + " 2>&1 </dev/null | grep -v '\"type\":\"message_update\"' "
        + "| stdbuf -oL tee "
        + shlex.quote(output_file)
    )
```

- [ ] **Step 5: Run the command tests and verify GREEN**

Run the same unittest command.

Expected: both tests pass.

- [ ] **Step 6: Write the failing pure staging tests**

Create `harbor_adapter/tests/test_staging.py`:

```python
import tempfile
import unittest
from pathlib import Path

from harbor_adapter.staging import (
    REQUIRED_TASK_ARTIFACTS,
    local_runtime_files,
    validate_local_checkout,
)


class StagingTests(unittest.TestCase):
    def test_runtime_file_allowlist_excludes_development_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.ts").write_text("export default () => {}\n")
            (root / "package.json").write_text("{}\n")
            (root / "src").mkdir()
            (root / "src" / "feature.ts").write_text("export const value = 1\n")
            (root / "tests").mkdir()
            (root / "tests" / "feature.test.ts").write_text("test\n")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "ignored.ts").write_text("ignored\n")
            (root / "findings.md").write_text("local notes\n")

            relative_paths = [
                relative.as_posix()
                for _, relative in local_runtime_files(root)
            ]

            self.assertEqual(
                relative_paths,
                ["index.ts", "package.json", "src/feature.ts"],
            )

    def test_validate_local_checkout_requires_index_and_src(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(FileNotFoundError, "index.ts"):
                validate_local_checkout(root)

            (root / "index.ts").write_text("export default () => {}\n")
            with self.assertRaisesRegex(FileNotFoundError, "src"):
                validate_local_checkout(root)

    def test_required_task_artifacts_are_only_long_horizon_files(self):
        self.assertEqual(REQUIRED_TASK_ARTIFACTS, ("plan.md", "progress.md"))
```

- [ ] **Step 7: Run staging tests and verify RED**

Run:

```bash
/Users/zard/.venvs/test/bin/python -m unittest harbor_adapter.tests.test_staging -v
```

Expected: collection fails with `ModuleNotFoundError: No module named 'harbor_adapter.staging'`.

- [ ] **Step 8: Implement pure staging discovery**

Create `harbor_adapter/staging.py`:

```python
from __future__ import annotations

from pathlib import Path

REQUIRED_TASK_ARTIFACTS = ("plan.md", "progress.md")


def repository_root() -> Path:
    return Path(__file__).resolve().parents[1]


def validate_local_checkout(root: Path) -> None:
    if not (root / "index.ts").is_file():
        raise FileNotFoundError(
            f"Long Horizon checkout is missing index.ts: {root}"
        )
    if not (root / "src").is_dir():
        raise FileNotFoundError(
            f"Long Horizon checkout is missing src/: {root}"
        )


def local_runtime_files(root: Path) -> list[tuple[Path, Path]]:
    validate_local_checkout(root)
    files: list[tuple[Path, Path]] = [(root / "index.ts", Path("index.ts"))]
    package_json = root / "package.json"
    if package_json.is_file():
        files.append((package_json, Path("package.json")))

    for source in sorted((root / "src").rglob("*.ts")):
        if source.is_file():
            files.append((source, source.relative_to(root)))

    return files
```

- [ ] **Step 9: Run all pure helper tests and verify GREEN**

Run:

```bash
/Users/zard/.venvs/test/bin/python -m unittest discover -s harbor_adapter/tests -v
```

Expected: all five tests pass.

- [ ] **Step 10: Commit the pure helpers**

```bash
git add harbor_adapter
git commit -m "feat: add Harbor staging and command helpers"
```

## Task 2: Add task-artifact validation and sandbox staging

**Files:**
- Modify: `harbor_adapter/staging.py`
- Modify: `harbor_adapter/tests/test_staging.py`

- [ ] **Step 1: Write failing async staging tests**

Append to `harbor_adapter/tests/test_staging.py`:

```python
import asyncio


class _ExecResult:
    def __init__(self, return_code: int):
        self.return_code = return_code


class _FakeEnvironment:
    def __init__(self, existing: set[str]):
        self.existing = existing
        self.commands: list[str] = []

    async def exec(self, *, command: str):
        self.commands.append(command)
        path = command.removeprefix("test -f ").strip("'")
        return _ExecResult(0 if path in self.existing else 1)


class _FakeAgent:
    def __init__(self):
        self.commands: list[str] = []
        self.uploads: list[tuple[Path, str]] = []

    async def exec_as_agent(self, environment, command: str):
        self.commands.append(command)

    async def _upload_agent_owned_file(self, environment, source: Path, target: str):
        self.uploads.append((source, target))


class TaskArtifactAndStagingTests(unittest.TestCase):
    def test_accepts_both_long_horizon_files(self):
        from harbor_adapter.staging import require_task_artifacts

        environment = _FakeEnvironment({"plan.md", "progress.md"})
        asyncio.run(require_task_artifacts(environment))
        self.assertEqual(len(environment.commands), 2)

    def test_reports_the_first_missing_long_horizon_file(self):
        from harbor_adapter.staging import require_task_artifacts

        environment = _FakeEnvironment({"plan.md"})
        with self.assertRaisesRegex(RuntimeError, "progress.md"):
            asyncio.run(require_task_artifacts(environment))

    def test_stages_only_runtime_files(self):
        from harbor_adapter.staging import stage_local_extension

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.ts").write_text("export default () => {}\n")
            (root / "src").mkdir()
            (root / "src" / "feature.ts").write_text("export const value = 1\n")
            (root / "tests").mkdir()
            (root / "tests" / "ignored.ts").write_text("ignored\n")

            agent = _FakeAgent()
            extension_path = asyncio.run(
                stage_local_extension(agent, object(), root)
            )

            self.assertEqual(
                extension_path.as_posix(),
                "/tmp/long-horizon-pi-extension/index.ts",
            )
            self.assertEqual(
                [target for _, target in agent.uploads],
                [
                    "/tmp/long-horizon-pi-extension/index.ts",
                    "/tmp/long-horizon-pi-extension/src/feature.ts",
                ],
            )
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
/Users/zard/.venvs/test/bin/python -m unittest harbor_adapter.tests.test_staging -v
```

Expected: the three new tests fail with missing `require_task_artifacts` or `stage_local_extension`.

- [ ] **Step 3: Implement task validation and local staging**

Append to `harbor_adapter/staging.py`:

```python
import shlex
from typing import Any

STAGED_ROOT = Path("/tmp/long-horizon-pi-extension")


async def require_task_artifacts(environment: Any) -> None:
    for relative_path in REQUIRED_TASK_ARTIFACTS:
        result = await environment.exec(
            command=f"test -f {shlex.quote(relative_path)}"
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"Harbor task environment is missing {relative_path}; "
                "provide it in the task environment before running Long Horizon"
            )


async def stage_local_extension(
    agent: Any,
    environment: Any,
    root: Path | None = None,
) -> Path:
    source_root = root or repository_root()
    files = local_runtime_files(source_root)
    destination_root = STAGED_ROOT.as_posix()

    await agent.exec_as_agent(
        environment,
        command=f"mkdir -p {shlex.quote(destination_root)}",
    )
    for source, relative_path in files:
        destination = STAGED_ROOT / relative_path
        await agent.exec_as_agent(
            environment,
            command=f"mkdir -p {shlex.quote(destination.parent.as_posix())}",
        )
        await agent._upload_agent_owned_file(
            environment,
            source,
            destination.as_posix(),
        )
    return STAGED_ROOT / "index.ts"
```

- [ ] **Step 4: Run the staging tests and verify GREEN**

Run the same unittest command.

Expected: all six staging tests pass.

- [ ] **Step 5: Commit task validation and staging**

```bash
git add harbor_adapter/staging.py harbor_adapter/tests/test_staging.py
git commit -m "feat: stage local Long Horizon files in Harbor"
```

## Task 3: Implement and test the Harbor LongHorizonPi agent

**Files:**
- Create: `harbor_adapter/agent.py`
- Create: `harbor_adapter/tests/test_agent.py`

- [ ] **Step 1: Write a failing Harbor-contract test with stub modules**

Create `harbor_adapter/tests/test_agent.py`. The test must inject minimal fake `harbor.*` modules into `sys.modules` before importing `agent.py`, because Harbor is not installed on this Mac:

```python
import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path


def load_agent_class():
    base_module = types.ModuleType("harbor.agents.installed.base")
    base_module.with_prompt_template = lambda function: function

    pi_module = types.ModuleType("harbor.agents.installed.pi")

    class FakePi:
        _resume = False

        def __init__(self, logs_dir=None, model_name=None, **kwargs):
            self.model_name = model_name
            self.model_connection = types.SimpleNamespace(
                provider=None,
                env={},
            )
            self.commands = []

        @staticmethod
        def name():
            return "pi"

        async def setup(self, environment):
            return None

        async def exec_as_agent(self, environment, command, env=None):
            self.commands.append((command, env))

        def _build_register_skills_command(self):
            return None

        def build_cli_flags(self):
            return ""

        def _get_env(self, name):
            return None

    pi_module.Pi = FakePi

    environment_module = types.ModuleType("harbor.environments.base")
    environment_module.BaseEnvironment = object
    context_module = types.ModuleType("harbor.models.agent.context")
    context_module.AgentContext = object

    modules = {
        "harbor": types.ModuleType("harbor"),
        "harbor.agents": types.ModuleType("harbor.agents"),
        "harbor.agents.installed": types.ModuleType("harbor.agents.installed"),
        "harbor.agents.installed.base": base_module,
        "harbor.agents.installed.pi": pi_module,
        "harbor.environments": types.ModuleType("harbor.environments"),
        "harbor.environments.base": environment_module,
        "harbor.models": types.ModuleType("harbor.models"),
        "harbor.models.agent": types.ModuleType("harbor.models.agent"),
        "harbor.models.agent.context": context_module,
    }
    sys.modules.update(modules)

    module_path = Path(__file__).parents[1] / "agent.py"
    spec = importlib.util.spec_from_file_location("harbor_adapter.agent_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.LongHorizonPi


class AgentContractTests(unittest.TestCase):
    def test_has_distinct_name(self):
        agent_class = load_agent_class()
        self.assertEqual(agent_class.name(), "long-horizon-pi")

    def test_run_uses_the_staged_extension_command(self):
        agent_class = load_agent_class()
        agent = agent_class(model_name="anthropic/test-model")
        agent._long_horizon_extension = "/tmp/long-horizon-pi-extension/index.ts"

        asyncio.run(agent.run("fix the parser", object(), object()))

        command = agent.commands[-1][0]
        self.assertEqual(command.count("--no-extensions"), 1)
        self.assertEqual(command.count("--extension"), 1)
        self.assertIn(
            "--extension /tmp/long-horizon-pi-extension/index.ts",
            command,
        )
```

- [ ] **Step 2: Run the agent tests and verify RED**

Run:

```bash
/Users/zard/.venvs/test/bin/python -m unittest harbor_adapter.tests.test_agent -v
```

Expected: import fails because `harbor_adapter/agent.py` does not exist.

- [ ] **Step 3: Implement the Harbor agent**

Create `harbor_adapter/agent.py`:

```python
from __future__ import annotations

from typing import override

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from harbor_adapter.command import build_pi_command
from harbor_adapter.staging import (
    require_task_artifacts,
    repository_root,
    stage_local_extension,
)


class LongHorizonPi(Pi):
    """Harbor Pi agent that explicitly loads the local Long Horizon extension."""

    _long_horizon_extension: str | None = None

    @staticmethod
    @override
    def name() -> str:
        return "long-horizon-pi"

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        await require_task_artifacts(environment)
        await super().setup(environment)
        extension_path = await stage_local_extension(
            self,
            environment,
            repository_root(),
        )
        self._long_horizon_extension = extension_path.as_posix()

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        extension_path = self._long_horizon_extension
        if extension_path is None:
            raise RuntimeError("Long Horizon extension was not staged during setup")
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, model = self.model_name.split("/", 1)
        access = self.model_connection
        provider = access.provider or provider
        env = dict(access.env)
        if provider == "anthropic" and (
            oauth_token := self._get_env("ANTHROPIC_OAUTH_TOKEN")
        ):
            env["ANTHROPIC_OAUTH_TOKEN"] = oauth_token

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)

        await self.exec_as_agent(
            environment,
            command=build_pi_command(
                instruction=instruction,
                provider=provider,
                model=model,
                extension_path=extension_path,
                resume=self._resume,
                cli_flags=self.build_cli_flags(),
            ),
            env=env,
        )
```

- [ ] **Step 4: Run the agent contract tests and verify GREEN**

Run:

```bash
/Users/zard/.venvs/test/bin/python -m unittest harbor_adapter.tests.test_agent -v
```

Expected: both tests pass.

- [ ] **Step 5: Compile the Harbor-dependent module**

Run:

```bash
/Users/zard/.venvs/test/bin/python -m compileall -q harbor_adapter
```

Expected: exit code 0. This verifies Python syntax; it does not replace the Harbor import smoke test.

- [ ] **Step 6: Commit the Harbor Agent**

```bash
git add harbor_adapter/agent.py harbor_adapter/tests/test_agent.py
git commit -m "feat: add local Long Horizon Harbor agent"
```

## Task 4: Document usage and task ownership

**Files:**
- Create: `harbor_adapter/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write the adapter README**

Create `harbor_adapter/README.md` with these sections and content:

- Requirements: Harbor 0.21-compatible API, Python 3.12+, Docker/provider, Node/Pi supplied by Harbor, and a local checkout of this repository.
- Task ownership: `task.toml`, `instruction.md`, `environment/`, and `tests/` come from task authors, `harbor tasks init`, published task packages, or benchmark adapters. Long Horizon additionally requires `plan.md` and `progress.md` in the agent working directory. The adapter only checks those files and never generates them.
- Local run command:

```bash
harbor run \
  --agent harbor_adapter.agent:LongHorizonPi \
  --model <provider/model> \
  -t /absolute/path/to/long-horizon-task
```

- Native Harbor Pi command for a no-plugin run, without making this adapter perform the comparison.
- EvoCodeBench note: the EvoCodeBench task data used with this adapter already provides the standard Harbor task files; conversion is outside this adapter.
- Local-only staging: the adapter uploads `index.ts`, `package.json` if present, and `src/**/*.ts`; it never calls GitHub, npm, `git clone`, or `pi install` to obtain Long Horizon.

- [ ] **Step 2: Add a root README link**

Add this section to `README.md` after the existing development instructions:

```markdown
## Harbor evaluation

The repository includes a local-only Harbor Agent adapter in
[`harbor_adapter/README.md`](harbor_adapter/README.md). It runs Harbor's Pi
agent with the local Long Horizon extension loaded explicitly. Harbor task
metadata and verifier files may come from `harbor tasks init`, a published task,
or a benchmark adapter; the task environment must additionally contain
`plan.md` and `progress.md`.

The adapter never downloads the plugin. Run Harbor from this checkout so
`harbor_adapter.agent:LongHorizonPi` is importable.
```

- [ ] **Step 3: Run documentation checks**

Run:

```bash
git diff --check
rg -n 'github|git clone|npm install|pi install' harbor_adapter/README.md README.md
```

Expected: matches only describe the local-only prohibition or installation context; no command tells the adapter to fetch the plugin remotely.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md harbor_adapter/README.md
git commit -m "docs: document Harbor adapter usage"
```

## Task 5: Verify, merge, and push

**Files:**
- No planning work files are included in the implementation commits.
- Do not stage `findings.md`, `task_plan.md`, `progress.md`, `node_modules`, or generated coverage.

- [ ] **Step 1: Run adapter tests and compilation**

```bash
/Users/zard/.venvs/test/bin/python -m unittest discover -s harbor_adapter/tests -v
/Users/zard/.venvs/test/bin/python -m compileall -q harbor_adapter
```

Expected: all adapter tests pass and compilation exits 0.

- [ ] **Step 2: Run existing TypeScript tests and typecheck**

```bash
npm test
npm run typecheck
```

Expected: 126 Vitest tests pass and TypeScript typecheck exits 0.

- [ ] **Step 3: Run repository checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended adapter/docs/design/plan files are changed on the feature branch.

- [ ] **Step 4: Run Harbor import smoke test if Harbor is installed**

From the repository root:

```bash
python -c 'from harbor_adapter.agent import LongHorizonPi; print(LongHorizonPi.name())'
```

Expected: `long-horizon-pi`.

If Harbor is not installed on this Mac, record that the smoke test was not run. Do not claim Harbor runtime compatibility from Python compilation alone.

- [ ] **Step 5: Review the feature diff**

```bash
git diff main...HEAD --stat
git diff main...HEAD -- harbor_adapter README.md docs/superpowers
```

Expected: only the Harbor adapter, tests, usage docs, design, and implementation plan are present.

- [ ] **Step 6: Merge the feature branch into main**

From `/Users/zard/long-horizon-pi-extension`:

```bash
git merge --ff-only feat/harbor-adapter
```

Expected: fast-forward merge with no conflict. Existing uncommitted local planning changes must remain uncommitted.

- [ ] **Step 7: Run fresh verification on merged main**

```bash
npm test
npm run typecheck
git diff --check
git status --short --branch
```

Expected: 126 TypeScript tests pass, typecheck passes, diff check passes, and only the pre-existing local planning changes remain uncommitted.

- [ ] **Step 8: Push main and verify the remote**

```bash
git push origin main
git ls-remote origin refs/heads/main
git rev-parse HEAD
```

Expected: push succeeds and the remote `main` hash equals local `HEAD`. Report whether Harbor runtime smoke testing was available.
