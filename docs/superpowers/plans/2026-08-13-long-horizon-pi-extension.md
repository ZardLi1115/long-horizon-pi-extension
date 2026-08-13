# Long-Horizon Pi Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pi 0.73.1 extension that reloads plan/progress/Git state before each model call, tracks owned file changes, completes one section per run by default, and supports persistent `/lh single` and `/lh multi` modes.

**Architecture:** Keep all canonical project state in the current cwd's `plan.md`, `progress.md`, and Git repository. Pure modules parse and update plan/progress; a small run state tracks the active section and owned paths; the Pi entrypoint wires context, lifecycle events, custom tools, slash commands, and compaction. The extension never edits Pi's Homebrew installation.

**Tech Stack:** TypeScript loaded by Pi's jiti, Node.js `fs/path/crypto`, Pi 0.73.1 ExtensionAPI, TypeBox, Vitest with the Pi package's installed test runner when available.

---

## File Map

- Create: `package.json` — local development scripts and Pi package type dependency.
- Create: `tsconfig.json` — strict type-checking for extension source and tests.
- Create: `vitest.config.ts` — test discovery and Node test environment.
- Create: `index.ts` — Pi entrypoint and lifecycle wiring only.
- Create: `src/types.ts` — plan, progress, Git, run, and context types.
- Create: `src/plan.ts` — plan parsing, ID generation, metadata, conflict detection, and plan working set.
- Create: `src/progress.ts` — bounded YAML-like progress parsing, normalization, transitions, and serialization.
- Create: `src/context-builder.ts` — dynamic context block and stable protocol prompt.
- Create: `src/git.ts` — Git command adapter, status classification, safe commit path selection, and output truncation.
- Create: `src/ownership.ts` — pending/owned/unowned path tracking for write/edit and custom file tools.
- Create: `src/run.ts` — run initialization, active section locking, attempts, and completion bookkeeping.
- Create: `src/section-tools.ts` — `complete_section`, `reopen_section`, `long_horizon_delete`, and `long_horizon_move` definitions.
- Create: `src/yaml.ts` — the small bounded YAML reader/writer used by `progress.md`.
- Create: `tests/plan.test.ts` — plan parser and working-set behavior.
- Create: `tests/progress.test.ts` — progress state transitions and round trips.
- Create: `tests/context.test.ts` — deterministic context and hint rendering.
- Create: `tests/git.test.ts` — Git classification and commit path selection.
- Create: `tests/ownership.test.ts` — ownership lifecycle.
- Create: `tests/run.test.ts` — single/multi run locking and section transitions.
- Create: `tests/section-tools.test.ts` — tool-level completion behavior using injected adapters.

## Task 1: Bootstrap the TypeScript testable project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/types.ts`

- [ ] **Step 1: Write the package and compiler configuration**

Use Pi's installed package for runtime types and TypeBox for tool schemas:

```json
{
  "name": "long-horizon-pi-extension",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mariozechner/pi-coding-agent": "file:/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent",
    "typebox": "file:/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/typebox"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "typescript": "^5.7.3",
    "vitest": "^3.2.4"
  }
}
```

`tsconfig.json` must use `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2022"`, `strict: true`, `noEmit: true`, and include `index.ts`, `src/**/*.ts`, and `tests/**/*.ts`.

- [ ] **Step 2: Add the domain types before implementation**

Define these exact interfaces/unions in `src/types.ts`: `Mode = "single" | "multi"`; `PlanSection` with `id`, `title`, `heading`, `chapter`, `needs`, optional `verify`/`brief`, `startLine`, `endLine`; `PlanDocument` with `sections`, `byId`, `chapters`, `missingIds`, `duplicateIds`, `conflictLines`; `ProgressState` with `active`, `attempts`, `done`, `blocker`, `tried`, `next`, `unknown`; `GitState` with `available`, `head`, `dirtyPaths`, `stagedPaths`, `conflictPaths`; `RunState` with mode, sectionId, baseHead, preexistingDirtyPaths, pendingPaths, ownedPaths, unownedPaths, completedSections, completed; and `ContextSnapshot`.

- [ ] **Step 3: Run the type checker**

Run `npm run typecheck`. Expected: it reports no source errors; test files may be empty at this point.

## Task 2: Implement plan parsing and progress state with tests first

**Files:**
- Create: `src/yaml.ts`
- Create: `src/plan.ts`
- Create: `src/progress.ts`
- Test: `tests/plan.test.ts`
- Test: `tests/progress.test.ts`

- [ ] **Step 1: Write failing plan tests**

Cover: explicit `id`, `section-id` alias, `needs`/`verify`/`brief`, generated slug ID plus `missingIds`, duplicate IDs as a hard error, conflict marker rejection, first unfinished section, and a bounded working set containing active neighbors and direct needs.

- [ ] **Step 2: Run the focused plan tests and observe the expected missing-module failures**

Run `npm test -- tests/plan.test.ts`. Expected: FAIL because `src/plan.ts` does not exist.

- [ ] **Step 3: Implement the minimum plan parser**

Parse `##` chapter headings and `###` sections. Read HTML comments only for the five supported keys. Generate a kebab-case slug from the title only when no ID exists; do not write the file in this pure module. Throw a `PlanError` when conflict markers or duplicate IDs exist. Return line boundaries and a one-hop working set.

- [ ] **Step 4: Run plan tests to green**

Run `npm test -- tests/plan.test.ts`; expected: all plan tests pass.

- [ ] **Step 5: Write failing progress tests**

Cover an empty/default state, canonical YAML-like round trip, unknown-field preservation, attempts increment/reset, active advancement to the next unfinished section, and reopen moving an ID from `done` to `active` with a reason.

- [ ] **Step 6: Run progress tests red**

Run `npm test -- tests/progress.test.ts`; expected: FAIL because the state functions are not implemented.

- [ ] **Step 7: Implement bounded progress parsing and transitions**

Support scalar `active`/`attempts`, list fields `done`/`blocker`/`tried`/`next`, and preserve unknown top-level lines under `unknown`. Serialize known fields in the canonical order shown in the design document. Implement `advanceProgress`, `incrementAttempt`, and `reopenProgress` without mutating inputs.

- [ ] **Step 8: Run progress tests to green and typecheck**

Run `npm test -- tests/progress.test.ts && npm run typecheck`; expected: all focused tests pass and typecheck exits 0.

## Task 3: Implement ownership, Git classification, and run state with tests first

**Files:**
- Create: `src/ownership.ts`
- Create: `src/git.ts`
- Create: `src/run.ts`
- Test: `tests/ownership.test.ts`
- Test: `tests/git.test.ts`
- Test: `tests/run.test.ts`

- [ ] **Step 1: Write failing ownership tests**

Verify pending write/edit paths are added only after a successful result, failed results are discarded, custom delete/move paths are owned after success, and bash/untracked paths remain unowned unless explicitly registered.

- [ ] **Step 2: Run ownership tests red**

Run `npm test -- tests/ownership.test.ts`; expected: FAIL because `src/ownership.ts` is absent.

- [ ] **Step 3: Implement the ownership tracker**

Normalize all paths relative to cwd, reject paths outside cwd, retain pending by tool-call ID, and expose `owned`, `unowned`, and `pending` snapshots. A successful move owns both source and target.

- [ ] **Step 4: Write failing Git tests**

Use a fake Git adapter to verify unavailable repositories are reported, pre-existing dirty/staged paths are excluded, unowned changes are not selected for commits, plugin-updated `plan.md`/`progress.md` are included, and conflict paths block completion.

- [ ] **Step 5: Run Git tests red**

Run `npm test -- tests/git.test.ts`; expected: FAIL because `src/git.ts` is absent.

- [ ] **Step 6: Implement Git adapter and commit selection**

Define `GitAdapter` methods around `pi.exec` (`rev-parse`, `status --porcelain=v1`, `diff`, `add`, `commit`). Parse porcelain output conservatively. `selectCommitPaths` must return only owned paths that differ from the run baseline plus explicitly plugin-touched canonical files, and return a boundary error if a path was pre-existing dirty/staged or if conflict markers remain.

- [ ] **Step 7: Write failing run-state tests**

Verify `startRun` locks `progress.active`, initializes attempts based on whether active changed, single rejects a different completion ID, multi accepts the next active section after a successful completion, and completed sections are tracked.

- [ ] **Step 8: Run run-state tests red, implement, then run green**

Run `npm test -- tests/run.test.ts`; expected first: FAIL because `src/run.ts` is absent. Implement pure transitions, rerun, and expect all run tests to pass.

## Task 4: Build context and Pi-independent section operations

**Files:**
- Create: `src/context-builder.ts`
- Create: `src/section-tools.ts`
- Test: `tests/context.test.ts`
- Test: `tests/section-tools.test.ts`

- [ ] **Step 1: Write failing context tests**

Assert stable protocol text mentions the required tools and single/multi semantics; dynamic context includes active section, progress, Git classification, and recovery hints for missing IDs, duplicate IDs, no Git, and failed verification; large plans use the working set rather than the entire document.

- [ ] **Step 2: Run context tests red**

Run `npm test -- tests/context.test.ts`; expected: FAIL because `src/context-builder.ts` is absent.

- [ ] **Step 3: Implement deterministic context rendering**

Provide `buildStableProtocol()` and `buildDynamicContext(snapshot)`. Keep dynamic data out of `before_agent_start.message`; return it as a hidden custom message from the Pi context hook. Include a compact owned/unowned summary.

- [ ] **Step 4: Write failing section-operation tests**

With injected filesystem, command, Git, and abort adapters, verify: a successful verify updates progress and selects a commit; a non-zero verify preserves active, increments attempts, truncates blocker output, and does not commit; missing verify is marked unverified; single schedules abort; multi does not; invalid section IDs and cross-section completion are rejected.

- [ ] **Step 5: Run section tests red**

Run `npm test -- tests/section-tools.test.ts`; expected: FAIL because section operation functions are absent.

- [ ] **Step 6: Implement section operations**

Keep `completeSection` independent of Pi schemas. The caller supplies `mode`, `run`, `plan`, `progress`, `verify`, `git`, `persistProgress`, `commit`, and `abort`. On success, advance active to the next unfinished section, clear blocker, reset attempts, record note in `next` only when supplied, and return a structured result. `reopenSection` must not reset Git or delete commits.

- [ ] **Step 7: Run focused tests and typecheck**

Run `npm test -- tests/context.test.ts tests/section-tools.test.ts && npm run typecheck`; expected: all pass and no type errors.

## Task 5: Wire the Pi Extension entrypoint and custom tools

**Files:**
- Create: `index.ts`
- Modify: `src/section-tools.ts` if needed for TypeBox adapters

- [ ] **Step 1: Add the Pi entrypoint with stable registrations**

Register `complete_section`, `reopen_section`, `long_horizon_delete`, `long_horizon_move` with TypeBox schemas and `executionMode: "sequential"` for state-changing section tools. Register `/lh` with `single`, `multi`, and `status` arguments and persist mode with `pi.appendEntry("long-horizon/mode", { mode })`.

- [ ] **Step 2: Wire session restoration and run start**

On `session_start`, scan the latest `long-horizon/mode` custom entry and default to `single`. On `before_agent_start`, load the current cwd state, create a run if no run is active, and return only stable protocol text. Do not inject plan/progress/Git here.

- [ ] **Step 3: Wire context, tool ownership, agent end, and compaction**

On `context`, reload disk state and return a hidden custom message. On `tool_call` capture write/edit pending paths; on successful `tool_result` commit ownership. On `agent_end`, report incomplete runs and owned/unowned/uncommitted paths. On `session_before_compact`, return a compact summary plus `details` containing current HEAD, active, mode, and a SHA-256 plan hash; if summary generation is unavailable, return nothing so Pi uses native compaction.

- [ ] **Step 4: Add safe delete/move implementations**

Use `fs.unlink` and `fs.rename` for one path at a time. Resolve both paths under cwd, reject `.git`, outside-cwd paths, missing sources, and existing move targets. Record ownership only after the filesystem operation succeeds.

- [ ] **Step 5: Run typecheck**

Run `npm run typecheck`; expected: exit 0. Fix only API/type mismatches revealed by the installed Pi 0.73.1 declarations.

## Task 6: Add package-local tests and Pi loading smoke tests

**Files:**
- Modify: `package.json`
- Modify: `task_plan.md`
- Modify: `progress.md`

- [ ] **Step 1: Install local development dependencies if needed**

Run `npm install` from the implementation worktree only if `node_modules` is absent. Do not modify `/opt/homebrew/lib/node_modules`.

- [ ] **Step 2: Run the full unit suite**

Run `npm test`; expected: all tests pass with zero failures.

- [ ] **Step 3: Run the compiled-TypeScript loading check**

Run `pi -e /Users/zard/long-horizon-pi-extension/.worktrees/implementation/index.ts --help` or the Pi equivalent that loads an extension without making a model request. Expected: Pi starts or prints help without an extension load/type error.

- [ ] **Step 4: Run a temporary fixture smoke test**

Create a temporary Git fixture outside the repository containing a two-section `plan.md`, `progress.md`, and one source file. Load the extension with `pi -e`; verify `/lh status`, `/lh multi`, and `/lh single` are registered. Do not commit fixture files into the extension repository.

- [ ] **Step 5: Review diff and update planning files**

Run `git diff --check`, `git status --short`, and `git diff --stat`. Update `task_plan.md` and `progress.md` with exact test output and any known limitations. Do not claim completion until these commands and the full test suite have been run.
