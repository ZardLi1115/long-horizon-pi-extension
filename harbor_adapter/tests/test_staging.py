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
