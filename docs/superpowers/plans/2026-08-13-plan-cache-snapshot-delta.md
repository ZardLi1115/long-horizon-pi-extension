# Plan Cached Snapshot and Section Delta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-call plan working-set injection with hidden persistent full-plan snapshots and append-only section/structure updates that improve prompt-prefix cache reuse while preserving exact canonical `plan.md` semantics.

**Architecture:** Add a host-agnostic `src/plan-cache.ts` module that splits exact section sources, builds a structure skeleton, hashes manifests, diffs observed and current plans, and renders snapshot/update messages. The Pi adapter restores manifests from hidden custom-message details, persists snapshots and updates at lifecycle boundaries, and retains only progress/Git/ownership in the temporary context hook. A successful compaction starts a new snapshot generation; failed or cancelled compaction leaves the previous generation intact.

**Tech Stack:** TypeScript, Node.js `crypto`, Pi Coding Agent 0.73.1 Extension API, Vitest.

---

## File Map

- Create: `src/plan-cache.ts` — exact plan segmentation, structure skeleton, hashes, manifests, diff, message rendering, and manifest restoration validation.
- Create: `tests/plan-cache.test.ts` — pure core behavior for snapshots, updates, tombstones, structure changes, ordering, and deduplication.
- Modify: `src/types.ts` — plan-cache manifest and update types shared by core and Pi adapter.
- Modify: `src/context-builder.ts` — remove temporary plan working set and add the stable override protocol.
- Modify: `tests/context.test.ts` — assert dynamic context contains only high-frequency state.
- Modify: `index.ts` — restore cache state, persist hidden messages, connect query/turn/end/compaction lifecycle events.
- Modify: `tests/index.test.ts` — Pi lifecycle integration tests for snapshot, delta, resume, single/multi, and compaction.
- Modify: `README.md` — document snapshot/delta semantics and Claude Code adapter boundary.
- Modify: `task_plan.md`, `progress.md`, `findings.md` — record final verification and known upstream dependency warning.

## Task 1: Define exact plan-cache types and parsing

**Files:**
- Modify: `src/types.ts`
- Create: `src/plan-cache.ts`
- Create: `tests/plan-cache.test.ts`

- [ ] **Step 1: Write failing exact-source parsing tests**

Add tests that call the wished-for API:

```ts
import { describe, expect, it } from "vitest";
import { parsePlanCacheDocument } from "../src/plan-cache.js";

describe("plan cache document", () => {
  it("preserves complete section source and builds a deterministic structure skeleton", () => {
    const source = [
      "# Plan",
      "",
      "Intro text.",
      "",
      "## Core",
      "",
      "### 1.2 Core Interface",
      "<!-- id: sec-core-interface -->",
      "",
      "Exact body.  ",
      "",
      "### 1.3 Errors",
      "<!-- id: sec-errors -->",
      "Error body.",
      "",
    ].join("\n");

    const document = parsePlanCacheDocument(source);

    expect(document.sections.get("sec-core-interface")?.source).toBe(
      "### 1.2 Core Interface\n<!-- id: sec-core-interface -->\n\nExact body.  \n",
    );
    expect(document.structureSource).toBe(
      "# Plan\n\nIntro text.\n\n## Core\n\n<!-- section: sec-core-interface -->\n<!-- section: sec-errors -->\n",
    );
    expect(document.order).toEqual(["sec-core-interface", "sec-errors"]);
  });

  it("rejects duplicate ids and conflict markers through the canonical parser", () => {
    expect(() => parsePlanCacheDocument("### A\n<!-- id: same -->\n### B\n<!-- id: same -->\n")).toThrow(/duplicate/);
    expect(() => parsePlanCacheDocument("<<<<<<< HEAD\n### A\n<!-- id: a -->\n=======\n>>>>>>> other\n")).toThrow(/conflict/);
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npm test -- tests/plan-cache.test.ts
```

Expected: FAIL because `src/plan-cache.ts` and `parsePlanCacheDocument` do not exist.

- [ ] **Step 3: Add the shared types**

Append these types to `src/types.ts`:

```ts
export interface PlanCacheSection {
  id: string;
  source: string;
  hash: string;
}

export interface PlanCacheDocument {
  source: string;
  planHash: string;
  structureSource: string;
  structureHash: string;
  order: string[];
  sections: Map<string, PlanCacheSection>;
}

export interface PlanCacheManifest {
  version: 1;
  generationId: string;
  planHash: string;
  structureHash: string;
  order: string[];
  sections: Array<{ id: string; hash: string }>;
}

export interface PlanSnapshotDetails extends PlanCacheManifest {
  kind: "snapshot";
}

export interface PlanUpdateDetails extends PlanCacheManifest {
  kind: "update";
  changedIds: string[];
  deletedIds: string[];
  structureChanged: boolean;
}

export interface PlanCacheDelta {
  changedIds: string[];
  deletedIds: string[];
  structureChanged: boolean;
  current: PlanCacheDocument;
}
```

- [ ] **Step 4: Implement exact segmentation and hashing**

In `src/plan-cache.ts`, implement:

```ts
import crypto from "node:crypto";
import { parsePlan } from "./plan.js";
import type { PlanCacheDocument, PlanCacheSection } from "./types.js";

function hash(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

export function parsePlanCacheDocument(source: string): PlanCacheDocument {
  const parsed = parsePlan(source);
  const lines = source.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const sections = new Map<string, PlanCacheSection>();
  const structure: string[] = [];
  let cursor = 0;

  for (const section of parsed.sections) {
    const start = section.startLine - 1;
    const end = section.endLine;
    structure.push(...lines.slice(cursor, start));
    structure.push(`<!-- section: ${section.id} -->\n`);
    const sectionSource = lines.slice(start, end).join("");
    sections.set(section.id, { id: section.id, source: sectionSource, hash: hash(sectionSource) });
    cursor = end;
  }
  structure.push(...lines.slice(cursor));
  const structureSource = structure.join("");
  return {
    source,
    planHash: hash(source),
    structureSource,
    structureHash: hash(structureSource),
    order: parsed.sections.map((section) => section.id),
    sections,
  };
}
```

Adjust boundary math only as required by the failing exact-source assertions; do not normalize whitespace or line endings.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test -- tests/plan-cache.test.ts
npm run typecheck
```

Expected: parsing tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the parsing core**

```bash
git add src/types.ts src/plan-cache.ts tests/plan-cache.test.ts
git commit -m "feat: parse exact plan cache snapshots"
```

## Task 2: Implement manifest diff, tombstones, structure updates, and renderers

**Files:**
- Modify: `src/plan-cache.ts`
- Modify: `tests/plan-cache.test.ts`

- [ ] **Step 1: Write failing diff and rendering tests**

Add focused tests for these APIs:

```ts
import {
  createPlanManifest,
  diffPlanCache,
  renderPlanSnapshot,
  renderPlanUpdate,
} from "../src/plan-cache.js";

it("renders only complete changed sections and a deletion tombstone", () => {
  const previous = parsePlanCacheDocument(
    "## Core\n### 1.2 Core Interface\n<!-- id: core -->\nold\n### 1.3 Removed\n<!-- id: removed -->\ngone\n",
  );
  const current = parsePlanCacheDocument(
    "## Core\n### 1.2 Core Interface\n<!-- id: core -->\nnew\n### 1.4 Added\n<!-- id: added -->\nadded body\n",
  );
  const delta = diffPlanCache(createPlanManifest("generation-1", previous), current);
  const rendered = renderPlanUpdate(delta);

  expect(delta.changedIds).toEqual(["core", "added"]);
  expect(delta.deletedIds).toEqual(["removed"]);
  expect(rendered).toContain("### 1.2 Core Interface\n<!-- id: core -->\nnew\n");
  expect(rendered).toContain("### 1.4 Added\n<!-- id: added -->\nadded body\n");
  expect(rendered).toContain("## removed\n\n<!-- deleted: true -->");
  expect(rendered).not.toContain("old\n");
});

it("renders __plan-structure__ when chapter text or order changes", () => {
  const previous = parsePlanCacheDocument("## Old\n### A\n<!-- id: a -->\nA\n### B\n<!-- id: b -->\nB\n");
  const current = parsePlanCacheDocument("## New\n### B\n<!-- id: b -->\nB\n### A\n<!-- id: a -->\nA\n");
  const delta = diffPlanCache(createPlanManifest("generation-1", previous), current);

  expect(delta.structureChanged).toBe(true);
  expect(renderPlanUpdate(delta)).toContain("## __plan-structure__");
  expect(renderPlanUpdate(delta)).toContain("<!-- section: b -->\n<!-- section: a -->");
});

it("produces no update for an identical observed manifest", () => {
  const current = parsePlanCacheDocument("### A\n<!-- id: a -->\nA\n");
  expect(diffPlanCache(createPlanManifest("generation-1", current), current)).toMatchObject({
    changedIds: [],
    deletedIds: [],
    structureChanged: false,
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
npm test -- tests/plan-cache.test.ts
```

Expected: FAIL because manifest/diff/render functions are missing.

- [ ] **Step 3: Implement manifest and diff transitions**

Implement these exports in `src/plan-cache.ts`:

```ts
export function createPlanManifest(generationId: string, document: PlanCacheDocument): PlanCacheManifest;
export function diffPlanCache(observed: PlanCacheManifest, current: PlanCacheDocument): PlanCacheDelta;
export function hasPlanCacheDelta(delta: PlanCacheDelta): boolean;
export function createSnapshotDetails(generationId: string, document: PlanCacheDocument): PlanSnapshotDetails;
export function createUpdateDetails(generationId: string, delta: PlanCacheDelta): PlanUpdateDetails;
```

Rules:

- Changed IDs follow `current.order`.
- Deleted IDs follow `observed.order`.
- `structureChanged` compares `structureHash`.
- Update details contain the complete current manifest, not only changed IDs.
- Unknown or duplicate IDs remain errors from `parsePlan()`.

- [ ] **Step 4: Implement deterministic snapshot/update rendering**

Implement:

```ts
export function renderPlanSnapshot(document: PlanCacheDocument): string;
export function renderPlanUpdate(delta: PlanCacheDelta): string;
```

The exact headers and override language must match the approved design. Emit changed sections in `changedIds` order, deleted tombstones in `deletedIds` order, then `__plan-structure__` when required. Do not add timestamps because they reduce deterministic cache reuse.

- [ ] **Step 5: Run core tests and typecheck**

```bash
npm test -- tests/plan-cache.test.ts
npm run typecheck
```

Expected: all plan-cache tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the diff core**

```bash
git add src/plan-cache.ts tests/plan-cache.test.ts
git commit -m "feat: diff and render plan cache updates"
```

## Task 3: Remove plan content from temporary dynamic context

**Files:**
- Modify: `src/context-builder.ts`
- Modify: `tests/context.test.ts`

- [ ] **Step 1: Write failing context protocol tests**

Change the context tests to assert:

```ts
it("keeps plan content out of the high-frequency dynamic tail", () => {
  const rendered = buildDynamicContext(snapshot);
  expect(rendered).not.toContain("## Plan working set");
  expect(rendered).not.toContain("### Active");
  expect(rendered).toContain("## Active position");
  expect(rendered).toContain("## Git state");
});

it("defines latest-update and tombstone precedence in stable protocol", () => {
  const protocol = buildStableProtocol();
  expect(protocol).toContain("Plan Cached Snapshot is the baseline");
  expect(protocol).toContain("latest Plan Update wins");
  expect(protocol).toContain("deleted tombstone");
});
```

- [ ] **Step 2: Run context tests and confirm RED**

```bash
npm test -- tests/context.test.ts
```

Expected: FAIL because dynamic context still renders a plan working set and stable protocol lacks override rules.

- [ ] **Step 3: Make the minimal context-builder change**

Remove `buildPlanWorkingSet` and `renderSection` usage from `src/context-builder.ts`. Keep active/progress/run/Git/ownership/hints unchanged. Add this stable protocol sentence exactly once:

```text
Plan Cached Snapshot is the baseline. For the same section ID, the latest Plan Update wins. A deleted tombstone removes all earlier versions.
```

- [ ] **Step 4: Run context tests and full typecheck**

```bash
npm test -- tests/context.test.ts
npm run typecheck
```

Expected: tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the context layout change**

```bash
git add src/context-builder.ts tests/context.test.ts
git commit -m "feat: move plan content into persistent cache messages"
```

## Task 4: Restore and persist snapshots at query boundaries

**Files:**
- Modify: `index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing initial snapshot and resume tests**

Extend the Pi mock to capture `before_agent_start` return messages and `pi.sendMessage()` calls. Add tests:

```ts
it("persists a hidden full snapshot before the first model call", async () => {
  // session_start with no plan-cache entries, then before_agent_start
  expect(result.message).toMatchObject({
    customType: "long-horizon/plan-cache",
    display: false,
    content: expect.stringContaining("[Plan Cached Snapshot]"),
    details: expect.objectContaining({ kind: "snapshot", version: 1 }),
  });
});

it("restores the latest manifest and emits only a query-gap update", async () => {
  // session entries contain snapshot details for old section content; disk contains new content
  expect(result.message.content).toContain("[Plan Updates Since Cached Snapshot]");
  expect(result.message.content).toContain("new body");
  expect(result.message.content).not.toContain("old body");
});

it("does not repeat an already-observed update after resume", async () => {
  // latest update details match disk
  expect(result.message).toBeUndefined();
});
```

- [ ] **Step 2: Run index tests and confirm RED**

```bash
npm test -- tests/index.test.ts
```

Expected: FAIL because the adapter does not restore or emit plan-cache messages.

- [ ] **Step 3: Add Pi plan-cache adapter state**

In `index.ts`, define constants and state:

```ts
const PLAN_CACHE_TYPE = "long-horizon/plan-cache";
let planCacheManifest: PlanCacheManifest | null = null;
let pendingInitialSnapshot = false;
```

Add pure adapter helpers in `index.ts`:

```ts
function restorePlanCacheManifest(entries: SessionEntryLike[]): PlanCacheManifest | null;
async function readPlanCache(cwd: string): Promise<PlanCacheDocument>;
function buildSnapshotMessage(document: PlanCacheDocument): PlanCacheMessage;
function buildUpdateMessage(document: PlanCacheDocument): PlanCacheMessage | null;
```

`restorePlanCacheManifest()` must scan branch entries in order, accept only `custom_message` entries whose `customType` is `PLAN_CACHE_TYPE`, validate `version === 1`, known `kind`, strings, unique section IDs and matching generation continuity, and return the last valid complete manifest.

- [ ] **Step 4: Wire `session_start` and `before_agent_start`**

On `session_start`:

- Restore the latest manifest from `ctx.sessionManager.getEntries()`.
- If none exists, set `pendingInitialSnapshot = true`.
- Do not send a model-triggering message.

On `before_agent_start`:

- Materialize missing plan IDs first using the existing `ensureRun()` path.
- Parse current exact plan.
- If initial, return a hidden Snapshot in `message` and update the in-memory manifest only after constructing that message.
- Otherwise diff and return a hidden Update only when non-empty.
- Continue returning the stable system prompt in the same result.

The message details are the complete snapshot/update manifest, so Pi persists recovery state alongside the exact prompt content.

- [ ] **Step 5: Run focused index tests and typecheck**

```bash
npm test -- tests/index.test.ts
npm run typecheck
```

Expected: initial/resume tests pass and existing run tests remain green.

- [ ] **Step 6: Commit query-boundary persistence**

```bash
git add index.ts tests/index.test.ts
git commit -m "feat: persist plan cache snapshots across sessions"
```

## Task 5: Coalesce tool-turn changes and persist agent-end fallbacks

**Files:**
- Modify: `index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing turn and agent-end tests**

Add tests that record `pi.sendMessage()` calls:

```ts
it("coalesces several same-turn plan writes into one final update", async () => {
  // establish snapshot, write intermediate 4.3, then final 4.3, fire turn_end once
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0][0].content).toContain("final 4.3");
  expect(sendMessage.mock.calls[0][0].content).not.toContain("intermediate 4.3");
  expect(sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: false });
});

it("persists an unobserved final plan change at agent_end without triggering a turn", async () => {
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ display: false, content: expect.stringContaining("final body") }),
    { triggerTurn: false },
  );
});

it("does not duplicate the turn_end update at agent_end", async () => {
  expect(sendMessage).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run index tests and confirm RED**

```bash
npm test -- tests/index.test.ts
```

Expected: FAIL because `turn_end` and plan-cache `agent_end` handlers are absent.

- [ ] **Step 3: Implement one serialized diff-and-persist function**

Add a small promise queue in `index.ts` to prevent `turn_end`, `agent_end`, and compaction races:

```ts
let planCacheQueue = Promise.resolve();

function enqueuePlanCache<T>(operation: () => Promise<T>): Promise<T> {
  const next = planCacheQueue.then(operation, operation);
  planCacheQueue = next.then(() => undefined, () => undefined);
  return next;
}
```

Add:

```ts
async function persistCurrentPlanDelta(ctx: ExtensionContext, delivery: "steer" | "idle"): Promise<boolean>;
```

It reads current plan once, diffs against `planCacheManifest`, returns false on no change, sends exactly one hidden message on change, and updates the in-memory manifest only after `await pi.sendMessage(...)` succeeds.

- [ ] **Step 4: Wire lifecycle hooks**

- `turn_end`: call the queued persistence function with `delivery: "steer"`; use `{ deliverAs: "steer", triggerTurn: false }`.
- `agent_end`: after existing incomplete-run reporting, call with `delivery: "idle"`; use `{ triggerTurn: false }`.
- Do not require a write/edit flag: always compare once so bash and external changes are detected.
- Identical observed hashes make the second hook a no-op.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
npm test -- tests/index.test.ts
npm run typecheck
```

Expected: coalescing/deduplication tests pass with existing Pi wiring tests.

- [ ] **Step 6: Commit lifecycle persistence**

```bash
git add index.ts tests/index.test.ts
git commit -m "feat: append coalesced plan updates between turns"
```

## Task 6: Start a fresh snapshot generation after successful compaction

**Files:**
- Modify: `index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing compaction-generation tests**

Add tests:

```ts
it("appends a fresh full snapshot only after successful compaction", async () => {
  await handlers.get("session_compact")?.[0]?.(
    { compactionEntry: { id: "compact-1", details: {} }, fromExtension: true },
    ctx,
  );
  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringContaining("[Plan Cached Snapshot]") }),
    { triggerTurn: false },
  );
});

it("does not reset the generation when compaction fails or never emits session_compact", async () => {
  // invoke session_before_compact fallback/error only, then change plan
  // next update keeps the old generationId
});

it("a post-compaction unchanged plan does not immediately create an update", async () => {
  // session_compact snapshot, then before_agent_start with same plan
  expect(result.message).toBeUndefined();
});
```

- [ ] **Step 2: Run index tests and confirm RED**

```bash
npm test -- tests/index.test.ts
```

Expected: FAIL because no `session_compact` plan-cache handler exists.

- [ ] **Step 3: Store exact plan metadata in compaction details**

Keep the existing `session_before_compact` native summary. Extend its details with the current cache generation and plan hash for diagnostics:

```ts
planCacheGenerationId: planCacheManifest?.generationId ?? null,
planHash: currentDocument.planHash,
```

Do not reset in-memory state in `session_before_compact`.

- [ ] **Step 4: Wire `session_compact`**

On the successful event:

- Serialize through `planCacheQueue`.
- Read and parse current exact plan.
- Generate a new UUID generation ID.
- Append a hidden full Snapshot with `{ triggerTurn: false }`.
- Update `planCacheManifest` only after send succeeds.
- Clear `pendingInitialSnapshot`.

Pi emits `session_compact` only after a saved compaction, so cancelled/failed attempts cannot reset the generation.

- [ ] **Step 5: Run compaction tests and typecheck**

```bash
npm test -- tests/index.test.ts
npm run typecheck
```

Expected: all compaction-generation tests pass.

- [ ] **Step 6: Commit compaction rebasing**

```bash
git add index.ts tests/index.test.ts
git commit -m "feat: rebase plan cache after compaction"
```

## Task 7: Verify tombstones, structure updates, mode behavior, and package loading

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `README.md`
- Modify: `task_plan.md`
- Modify: `progress.md`
- Modify: `findings.md`

- [ ] **Step 1: Add final Pi integration regressions**

Add adapter-level tests for:

```ts
it("emits a tombstone when a cached section is deleted", async () => {
  expect(update.content).toContain("## deleted-id\n\n<!-- deleted: true -->");
});

it("emits __plan-structure__ for chapter text and order changes", async () => {
  expect(update.content).toContain("## __plan-structure__");
});

it("uses the same plan-cache lifecycle in single and multi modes", async () => {
  // mode changes affect run semantics, not snapshot/update generation
});

it("does not treat hidden cache messages as owned Git paths", async () => {
  // completion selection remains based on real plan.md/progress.md/files only
});
```

- [ ] **Step 2: Run focused and full tests**

```bash
npm test -- tests/plan-cache.test.ts tests/context.test.ts tests/index.test.ts
npm test
npm run typecheck
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Update user documentation**

In `README.md`, document:

- full hidden Plan Cached Snapshot at generation start;
- append-only complete-section updates and latest-ID-wins semantics;
- deletion tombstones and `__plan-structure__`;
- fresh baseline after compaction;
- temporary progress/Git tail;
- the feature remains an independent Pi adapter over host-agnostic core and is intended for future Claude Code adaptation.

- [ ] **Step 4: Run package and Pi loading checks**

```bash
npm pack --dry-run
pi -e "$PWD/index.ts" --help
```

Expected: package contains `src/plan-cache.ts`; Pi prints help without extension errors.

- [ ] **Step 5: Run clean-install verification**

Copy the repository without `.git`, `.worktrees`, or `node_modules` to a fresh temporary directory, then run:

```bash
npm ci
npm test
npm run typecheck
```

Expected: clean install succeeds; the known Pi 0.73.1 upstream audit warning may remain, but all tests and typecheck pass.

- [ ] **Step 6: Run isolated Pi package/RPC smoke test**

Using a fresh `PI_CODING_AGENT_DIR`:

```bash
pi install "$PWD"
pi --mode rpc --offline --no-session
```

Send `{"type":"get_commands"}` and verify `/lh` is loaded from the package manifest. Do not modify the real `~/.pi` settings.

- [ ] **Step 7: Update planning records with fresh evidence**

Record exact test counts and smoke-test results in `task_plan.md`, `progress.md`, and `findings.md`. Keep the upstream deprecated Mario namespace/audit warning as a documented compatibility limitation; do not run `npm audit fix --force`.

- [ ] **Step 8: Review the final diff and commit**

```bash
git diff --check
git status --short
git diff --stat
git add README.md task_plan.md progress.md findings.md tests/index.test.ts
git commit -m "docs: document plan snapshot cache workflow"
```

## Task 8: Final review, merge, and public release

**Files:**
- No source changes expected unless review finds a verified defect.

- [ ] **Step 1: Request final code review**

Review the complete branch against both design documents, focusing on:

- hidden persistent message ordering and resume behavior;
- exact source preservation and deterministic output;
- lifecycle race serialization;
- compaction generation reset only after success;
- no regression in safe filesystem or atomic Git transactions;
- independent-plugin and future host-adapter boundaries.

Fix every Critical or Important issue using a failing regression test first, then re-run the full verification suite.

- [ ] **Step 2: Run fresh completion verification**

```bash
npm test
npm run typecheck
git diff --check
pi -e "$PWD/index.ts" --help
```

Expected: zero failures and no extension load error.

- [ ] **Step 3: Commit any review fixes**

```bash
git add <only-reviewed-files>
git commit -m "fix: address final plan cache review"
```

Skip this commit if review requires no changes.

- [ ] **Step 4: Fast-forward local main**

From `/Users/zard/long-horizon-pi-extension`:

```bash
git merge --ff-only feat/long-horizon-extension
npm test
npm run typecheck
```

Expected: merge succeeds and merged `main` passes all tests.

- [ ] **Step 5: Create and push the public GitHub repository**

```bash
gh repo create long-horizon-pi-extension \
  --source /Users/zard/long-horizon-pi-extension \
  --remote origin \
  --public \
  --push
```

Expected: `https://github.com/ZardLi1115/long-horizon-pi-extension` exists as a public repository and `main` is pushed.

- [ ] **Step 6: Verify the release state**

```bash
gh repo view ZardLi1115/long-horizon-pi-extension
git remote -v
git status --short --branch
```

Expected: repository visibility is public, origin targets the new repository, and local `main` is clean and tracks the pushed branch.
