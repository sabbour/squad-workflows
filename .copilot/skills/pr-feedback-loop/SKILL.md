---
name: "pr-feedback-loop"
description: "Full PR feedback loop lifecycle — scan, batch fix, thread resolution, merge gate, wave boundary"
domain: "orchestration"
confidence: "high"
source: "extracted from buildRalphCharterBlock() in squad-workflows init.mjs"
---

## Context

Ralph drives the PR feedback loop to clear the board: zero open squad PRs, zero open `squad:*` issues. This skill defines the complete lifecycle Ralph follows — from scanning open PRs for unresolved feedback to merging and checking wave completion.

The board is clear when there are 0 open PRs from squad bots and 0 open issues with `squad:*` labels.

## Initiation

Ralph initiates the feedback loop when any of the following is true:

- `squad_workflows_address_all_feedback(owner, repo)` returns data (one or more PRs with unresolved review threads)
- Any open squad PR has `CHANGES_REQUESTED` review state
- A PR has unresolved review threads but is otherwise approved

Ralph does NOT wait to be explicitly asked. When active, this loop is Ralph's primary work queue.

## Patterns

### Scan Pattern

Use either tool depending on scope:

- `squad_workflows_address_all_feedback(owner, repo)` — scans **all** open PRs for unresolved threads (Ralph's primary scan)
- `squad_workflows_address_feedback(pr, owner, repo)` — targets a **single PR** (useful when re-checking after a fix)

Both return structured data: file paths, line numbers, reviewer suggestions, category (codereview/security/docs/architecture). Ralph uses `squad_workflows_address_all_feedback` as the full work queue for each cycle.

### Prioritization

Sort PRs in this order:

1. **CI failures first** — unblock builds before addressing review comments
2. **CHANGES_REQUESTED** — reviewer has blocked merge; must address
3. **Approved but unresolved threads** — cleanup needed before merge gate passes

Skip PRs with unresolvable blockers (merge conflicts requiring human judgment, missing human-only approval, repeated CI failures after 2 fix attempts). Log why and move on.

### Batch Fix Pattern

For each actionable PR:

1. Spawn the **authoring agent** (the one whose bot identity matches the PR's branch — e.g., `squad-backend[bot]` → Kif) with the **full structured thread batch** as input.
2. The spawned agent must:
   - Read `.copilot/skills/pr-feedback-loop/SKILL.md` and `.copilot/skills/git-workflow/SKILL.md`
   - Address **all** related feedback in **one implementation pass**
   - Validate once (run tests/build)
   - Create **one commit for the entire batch** before pushing with `squad_workflows_push`
3. Do not loop thread-by-thread with separate commits — one batch, one commit.

### Thread Resolution Protocol

After the batch push, follow this exact order:

1. **Fix** — batch commit pushed
2. **Consolidated PR comment** — post one summary comment referencing the commit SHA and all addressed concerns (use `squad_reviews_post_feedback_batch`)
3. **Reply to each thread** — using `squad_reviews_resolve_thread(pr, threadId, commentId, reply, action)`:
   - `reply`: `"Addressed in {sha}: {description}"` (must be substantive, may reference consolidated comment)
   - `action`: `"addressed"` (or `"dismissed"` with justification if feedback does not apply)
   - **Identity**: replies MUST use the **PR author's bot identity** (the authoring agent's `roleSlug`), NOT Ralph's identity
4. **Resolve** — mark thread resolved
5. **Check `reviewDecision`** — proceed to two-step closure

Never resolve a thread without replying. Silent dismissal is a governance violation.

### Two-Step Closure

After all threads are resolved:

1. Check the PR's `reviewDecision`.
2. If still `CHANGES_REQUESTED`: ping the human reviewer for re-review or dismissal. **Do not self-close.**
3. Squad role-gate approval is **separate**: submit via `squad_reviews_execute_pr_review`. Thread resolution or human dismissal does not satisfy role gates.

### Re-Request Review

After thread resolution, call `squad_reviews_dispatch_review(pr, role)` for the reviewer role that left feedback. This applies the `review:{role}:requested` label and posts a notification comment.

### Merge Gate

```
squad_workflows_merge_check(pr)  →  squad_workflows_merge(pr)
```

The merge check validates: all required approvals + CI green + 0 unresolved threads + branch current + changeset present.

If the gate fails **only** because the branch is behind base:
```
squad_workflows_update_branch(pr)  →  retry merge_check once
```

If the gate is stuck due to self-approval: read `.copilot/skills/self-approval-fallback/SKILL.md`.

### Wave Boundary Check

After all PRs in the cycle are processed:

```
squad_workflows_wave_status(owner, repo)
```

If a wave (milestone) just completed: report to user and **pause for release coordination** (see `.copilot/skills/release-process/SKILL.md`). Do not continue into the next wave without acknowledgment. Otherwise, loop back to the scan step.

## Examples

### Simple: One PR, one thread, one fix commit, merge

**Setup:** PR #42 from `squad-backend[bot]` (Kif), one review thread requesting error handling.

1. Ralph calls `squad_workflows_address_all_feedback(owner, repo)` → returns PR #42 with 1 unresolved thread
2. Ralph prioritizes: single CHANGES_REQUESTED PR
3. Ralph spawns Kif with the thread batch: `{pr: 42, threads: [{path: "src/api.ts", line: 18, body: "Add error handling"}]}`
4. Kif reads the skill, fixes error handling, runs `npm test`, commits: `"fix: add error handling in api.ts (batch fixes #42)"`, pushes with `squad_workflows_push`
5. Ralph posts consolidated PR comment via `squad_reviews_post_feedback_batch` summarizing commit SHA
6. Ralph (via Kif's `roleSlug`) calls `squad_reviews_resolve_thread(42, threadId, commentId, "Addressed in abc1234: added try/catch with typed error response", "addressed")`
7. Ralph checks `reviewDecision` → `APPROVED` ✓
8. Ralph calls `squad_reviews_dispatch_review(42, "codereview")` to notify reviewer
9. Ralph calls `squad_workflows_merge_check(42)` → all-clear
10. Ralph calls `squad_workflows_merge(42)` → merged, branch deleted
11. Ralph calls `squad_workflows_wave_status(owner, repo)` → wave still in progress, loop back

### Complex: Two PRs, multiple threads, one skipped (merge conflict), one merged

**Setup:** PR #55 from `squad-frontend[bot]` (Zara), 3 threads; PR #56 from `squad-backend[bot]` (Kif), has merge conflict.

1. Ralph scans → two PRs with unresolved threads
2. Ralph prioritizes: PR #56 has merge conflict (unresolvable blocker) → skip, log: `"PR #56 skipped: merge conflict requires human resolution"`
3. Ralph processes PR #55: spawns Zara with all 3 threads as one batch
4. Zara implements all 3 fixes, one commit, pushes
5. Ralph posts one consolidated comment on PR #55
6. Ralph (via Zara's `roleSlug`) resolves all 3 threads with replies referencing the commit
7. Ralph checks `reviewDecision` on PR #55 → still `CHANGES_REQUESTED` (reviewer hasn't re-reviewed)
8. Ralph pings human reviewer: `"All 3 threads resolved in def5678. Please re-review or dismiss to unblock merge."`
9. After human dismisses: Ralph calls `squad_reviews_execute_pr_review` for Squad role-gate
10. Ralph calls `squad_workflows_merge_check(55)` → all-clear → `squad_workflows_merge(55)`
11. Ralph calls `squad_workflows_wave_status` → wave 2 complete → reports to user, pauses

## Anti-Patterns

- ❌ **Per-thread commits** — one commit per thread causes rebase churn and may invalidate approvals. Always batch into one commit per PR feedback cycle.
- ❌ **Resolving threads without replying** — governance violation. Every resolved thread needs a substantive reply before resolution.
- ❌ **Using Ralph's bot identity for thread replies** — thread replies must come from the PR author's bot identity (the authoring agent's `roleSlug`). Ralph orchestrates; the authoring bot speaks.
- ❌ **Calling `squad_workflows_update_all_branches()` proactively** — only call `squad_workflows_update_branch(pr)` on a specific PR, and only when `merge_check` fails solely due to stale branch.
- ❌ **Self-approving PRs** — Ralph may not approve a PR he (or his bot) authored. See `.copilot/skills/self-approval-fallback/SKILL.md`.
- ❌ **Continuing into a new wave without acknowledgment** — when a wave completes, pause and report. Do not auto-start the next wave.
- ❌ **Stalling on unresolvable blockers** — if a PR is blocked by merge conflicts or missing human approval, skip it, log the reason, and move to the next PR.
