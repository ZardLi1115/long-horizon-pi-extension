from __future__ import annotations

import shlex
from typing import Any
from pathlib import Path

REQUIRED_TASK_ARTIFACTS = ("plan.md", "progress.md")
STAGED_ROOT = Path("/tmp/long-horizon-pi-extension")


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
