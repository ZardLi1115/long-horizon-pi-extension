# Long Horizon Pi Extension

A standalone workflow plugin for [Pi Coding Agent](https://github.com/badlogic/pi-mono). It adds recoverable, section-based execution for long-running coding work without patching Pi, `pi-agent-core`, or Pi's global settings.

Pi is the first host adapter. The planning, progress, Run, ownership, and Git transaction logic lives in `src/`; `index.ts` is the Pi-specific adapter. This boundary is intended to support a future Claude Code adapter without rewriting the workflow core.

## What it does

- Captures `plan.md`, `progress.md`, and Git state once at the start of each user query.
- Defaults to one active section per user query (`single`).
- Supports persistent `/lh multi` mode for completing several sections in one query while committing each section separately.
- Tracks write/edit/delete/move ownership; only files explicitly owned by the run or touched by the runtime are selected for automatic commits.
- Provides `complete_section`, `record_attempt_failure`, `reopen_section`, `long_horizon_delete`, and `long_horizon_move` tools.
- Uses Pi's native model summarization for compaction, then appends only Long Horizon execution state.
- Caches the full `plan.md` as a hidden persistent snapshot and appends only changed sections between compactions.

## Requirements

- Node.js 20.6 or newer
- Pi Coding Agent 0.73.1 or newer
- A Git repository for automatic section commits

The extension uses Node.js filesystem and child-process APIs directly. It does not require `python3` or the `env` executable. String verification commands run through the user's shell (`$SHELL` on Unix-like systems and `ComSpec` on Windows), rather than a hard-coded `sh -lc` invocation. File operations validate every path component and use no-follow final-leaf opens where the host supports them. Node does not expose the previous descriptor-relative `openat` flow, so this is not a guarantee against a hostile concurrent parent-directory swap.

## Install

Install directly as a Pi package:

```bash
pi install https://github.com/ZardLi1115/long-horizon-pi-extension
```

Pi records the package in its settings and loads the extension declared by the repository's `pi.extensions` manifest. This is plugin installation; it does not patch Pi's source.

For development, clone and install test dependencies:

```bash
git clone https://github.com/ZardLi1115/long-horizon-pi-extension.git
cd long-horizon-pi-extension
npm install
```

Load it explicitly while developing:

```bash
pi -e /absolute/path/to/long-horizon-pi-extension/index.ts
```

Alternatively, make Pi discover a development checkout by linking the repository into Pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/long-horizon-pi-extension ~/.pi/agent/extensions/long-horizon
```

The link is an installation mechanism only. The extension remains a separate project and does not modify Pi's source or package files.

## Project files

Run Pi from a Git project whose current directory contains:

```text
plan.md
progress.md
```

Example `plan.md`:

```markdown
### Implement authentication
<!-- id: auth -->
<!-- verify: npm test -- auth -->

### Add account settings
<!-- id: settings -->
<!-- needs: auth -->
```

`section.verify` is used automatically when `complete_section` does not provide a different `verify`. To complete without running a configured verification command, pass `skipVerify: true`; `verify` and `skipVerify` cannot be used together.

Example `progress.md`:

```yaml
active: auth
attempts: 0

done:

blocker:

tried:

next:
```

## Commands

```text
/lh status
/lh single
/lh multi
```

`single` is the default. Mode changes are stored in the Pi session as extension data; they do not change Pi's global configuration.

`attempts` counts model-declared concrete failures, not agent turns. Call `record_attempt_failure` only after a concrete attempt failed or a concrete approach was abandoned:

```text
record_attempt_failure(
  id: "auth",
  tried: "rotated the refresh token before persistence",
  blocker: "the replay test still accepts the old token",
  next: "inspect the persistence transaction"
)
```

Verification failure returns its output to the model but does not increment `attempts` or write `progress.md` by itself.

## Plan cache behavior

At the beginning of a cache generation, the extension adds the complete `plan.md` as a hidden session message. When the file changes, it compares the current bytes with the last observed manifest and appends the complete latest source for each changed section. The latest occurrence of a section ID wins.

Deleted sections are represented by tombstones. Changes to chapter text, section order, or other text outside sections append a `__plan-structure__` snapshot. Human edits, agent tools, bash, scripts, and external editors are handled identically because the extension diffs the canonical file on disk.

At the start of each user query, the extension appends one hidden `[Long-Horizon Query Snapshot]` containing the current progress, Git, ownership, and recovery state. That snapshot remains unchanged throughout the agent loop; `record_attempt_failure` and `complete_section` return state changes directly in their tool results, while runtime checks re-read canonical files and Git before performing sensitive operations. The extension does not use Pi's per-request `context` hook for this state.

After a successful Pi compaction, a new full plan snapshot and generation ID are appended. Failed or cancelled compaction does not reset the existing generation.

Ownership is recorded only after a successful `write`, `edit`, `delete`, or `move`. The extension also stores the resulting content state and refuses section completion if an owned file was changed later by a formatter, verification command, shell command, or another external process. Dirty paths left at a section boundary are reported as unowned until the next run explicitly owns them. The current version intentionally does not protect user edits that overlap a path the agent or runtime owns; hunk-level ownership is a later improvement.

## Development

```bash
npm test
npm run typecheck
```

## Architecture

```text
src/       host-agnostic workflow core
index.ts   Pi Extension API adapter
tests/     core and Pi wiring tests
```

Canonical project state stays in `plan.md`, `progress.md`, and Git. Snapshot/update messages are a recoverable cache representation, not a second source of truth. Session compaction stores only non-canonical working memory plus metadata such as the current HEAD and plan hash.
