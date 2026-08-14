# Harbor adapter

This package exposes a local Harbor custom Agent that runs Harbor's built-in
Pi agent with the Long Horizon extension explicitly loaded.

## Requirements

- Harbor with the 0.21-compatible custom-agent API
- Python 3.12 or newer for the Harbor runtime
- A working Harbor Docker/provider setup
- Node.js and Pi supplied by the Harbor environment
- A local checkout of this repository

Harbor task metadata is separate from this adapter. The task package supplies
`task.toml`, `instruction.md`, `environment/`, and `tests/`, for example from
task authors, Harbor task tooling, a published task package, or a benchmark
dataset. The Long Horizon task environment must additionally contain:

```text
plan.md
progress.md
```

The adapter only checks those two files. It never generates Harbor task files
or Long Horizon planning files.

## Run with Long Horizon

Run Harbor from this repository so the local Python module is importable:

```bash
harbor run \
  --agent harbor_adapter.agent:LongHorizonPi \
  --model <provider/model> \
  -t /absolute/path/to/long-horizon-task
```

For a no-plugin comparison, use Harbor's native Pi agent with the same task
and model:

```bash
harbor run \
  --agent pi \
  --model <provider/model> \
  -t /absolute/path/to/long-horizon-task
```

The adapter stages only these local runtime files into the Harbor sandbox:

- `index.ts`
- `package.json`, when present
- `src/**/*.ts`

It does not download Long Horizon or ask another package manager to obtain it.
The extension is loaded explicitly with Pi's `--no-extensions` and
`--extension` options, so this adapter does not depend on Pi's global
extension discovery settings.

## Dataset scope

The EvoCodeBench task data used with this adapter already supplies the
standard Harbor task files. Converting another benchmark's raw format into a
Harbor task package is outside the scope of this adapter.
