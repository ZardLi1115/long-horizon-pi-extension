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
