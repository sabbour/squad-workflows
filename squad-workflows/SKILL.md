---
name: "squad-workflows"
description: "Issue-to-merge workflow orchestration for Squad agents"
domain: "workflow, ceremonies, planning, delivery"
confidence: "high"
---

# Squad Workflows Protocol

Use this skill to orchestrate the full issue-to-merge lifecycle with wave-based incremental delivery.

## Workflow Sequence

```
estimate → decompose (if L/XL) → design proposal → design review → code → PR review → merge
```

### 1) Estimate

Analyze an issue and auto-apply a story point estimate:

- `squad_workflows_estimate` — analyzes description, acceptance criteria, file references, and complexity signals
- Auto-applies `estimate:S` (1pt), `estimate:M` (3pts), `estimate:L` (8pts), or `estimate:XL` (20pts)
- If L/XL: must decompose before proceeding

### 2) Decompose (large issues only)

Break a large issue into independently shippable waves:

- `squad_workflows_decompose` — creates GitHub milestones + child issues
- Each wave has **demo criteria** (what you can test after it ships)
- Max issue estimate per wave: M (enforced)
- Wave = Milestone = Releasable changeset

### 3) Fast Lane Check

Before Design Proposal, check if the issue can skip ceremonies:

- `squad_workflows_fast_lane` — checks for `estimate:S` or `squad:chore-auto`
- Fast-lane skips: Design Proposal + Design Review
- Fast-lane keeps: PR Review Gate

### 4) Design Proposal

Post a DP comment with required sections:

- `squad_workflows_post_design_proposal` — validates completeness, posts formatted comment
- Required: problem, estimate, approach, subtasks, files, security, docs, alternatives
- Adds `design-proposal` label

### 5) Design Review

Check if all reviewers have approved:

- `squad_workflows_check_design_approval` — checks for `architecture:approved`, `security:approved`, `codereview:approved`
- Returns missing approvals and blockers

### 6) Coding Phase (use standard CLI)

After design approval:

```bash
# Create worktree (MANDATORY — never git checkout -b in top-level repo)
git worktree add .worktrees/{issue} -b squad/{issue}-{slug} origin/dev

# Work in worktree
cd .worktrees/{issue}

# Create draft PR
gh pr create --draft --base dev --title "feat: description (#issue)"

# Include changeset
npm run changeset
```

### 7) PR Review Phase

Track review progress:

- `squad_workflows_check_feedback` — lists unresolved review threads
- `squad_workflows_check_ci` — checks CI status with failure details
- Batch all related feedback for a PR into one implementation pass, one validation run, and one commit before pushing.
- Prefer one consolidated PR comment/update summarizing the batch; then use `squad_reviews_resolve_thread` to close individual threads (reply before resolve!) with concise references to the batch.
- After all threads are resolved, check PR `reviewDecision`. If it is still `CHANGES_REQUESTED`, ping the human reviewer for re-review/dismissal. Separately submit any required Squad role-gate approval with `squad_reviews_execute_pr_review`.

### 8) Merge

Validate and merge:

- `squad_workflows_merge_check` — holistic validation (approvals + threads + CI + changeset + branch current)
- `squad_workflows_merge` — squash merge + cleanup + wave completion check

### 9) Wave Completion & Release

When the last issue in a wave merges:

- `squad_workflows_wave_status` — reports which waves are complete and releasable
- `squad_workflows_release_wave` — validates completeness, runs `changeset version`, closes milestone, posts summary
  - Aggregates all pending changesets from the wave's PRs
  - Bumps package versions and updates CHANGELOG via changesets
  - Closes the GitHub milestone
  - Posts a wave summary comment on the parent issue (if linked)
  - Use `--dry-run` to preview without making changes
  - After release_wave, commit version bumps and push to trigger the release pipeline

## Utility Tools

- `squad_workflows_status` — current phase + blockers + next steps for any issue
- `squad_workflows_board_sync` — sync project board column (GraphQL mutations)
- `squad_workflows_wave_status` — milestone progress + releasability

## Setup

- `squad_workflows_init` — one-time repo setup (labels, config, instruction patches)
- `squad_workflows_doctor` — health check
