import asyncio
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

    async def _upload_agent_owned_file(
        self,
        environment,
        source: Path,
        target: str,
    ):
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
