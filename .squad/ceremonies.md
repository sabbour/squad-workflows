# Ceremonies

> Team meetings that happen before or after work. Each squad configures their own.

## Design Review

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | before |
| **Condition** | multi-agent task involving 2+ agents modifying shared systems |
| **Facilitator** | lead |
| **Participants** | all-relevant |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. Review the task and requirements
2. Agree on interfaces and contracts between components
3. Identify risks and edge cases
4. Assign action items

---

## Retrospective

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | after |
| **Condition** | build failure, test failure, or reviewer rejection |
| **Facilitator** | lead |
| **Participants** | all-involved |
| **Time budget** | focused |
| **Enabled** | ✅ yes |

**Agenda:**
1. What happened? (facts only)
2. Root cause analysis
3. What should change?
4. Action items for next iteration


---

## Retrospective with Enforcement

| Field | Value |
|-------|-------|
| **Trigger** | auto |
| **When** | weekly |
| **Condition** | No *retrospective* log in .squad/log/ within the last 7 days |
| **Facilitator** | lead |
| **Participants** | all |
| **Time budget** | focused |
| **Enabled** | yes |
| **Enforcement skill** | retro-enforcement |

**Agenda:**
1. What shipped this week? (closed issues, merged PRs)
2. What did not ship? (open issues, blockers)
3. Root cause on any failures
4. Action items -- each MUST become a GitHub Issue labeled retro-action

**Coordinator integration:**
At round start, call Test-RetroOverdue (see skill retro-enforcement). If overdue, run this ceremony before the work queue.

**Why GitHub Issues, not markdown:**
Production data: 0% completion across 6 retros using markdown checklists, 100% after switching to GitHub Issues.

<!-- squad-workflows: start -->
### Planning Ceremony (squad-workflows)

| Step | Tool | Gate |
|------|------|------|
| Estimate issue | `squad_workflows_estimate` | Auto-applies `estimate:S/M/L/XL` label |
| Decompose (if L/XL) | `squad_workflows_decompose` | Creates milestones + child issues |
| Fast-lane check | `squad_workflows_fast_lane` | Issues labeled `estimate:S` or `squad:chore-auto` skip Design Proposal and Design Review |

### Design Ceremony

| Step | Tool | Gate |
|------|------|------|
| Post Design Proposal | `squad_workflows_post_design_proposal` | Posts DP comment on issue, adds `design-proposal` label |
| Check Design Approval | `squad_workflows_check_design_approval` | Blocks until all approval labels present: `architecture:approved`, `security:approved`, `codereview:approved`, `docs:approved` |

### Review Ceremony

| Step | Tool | Gate |
|------|------|------|
| Check review feedback | `squad_workflows_check_feedback` | Lists unresolved review threads — all must be resolved before merge |
| Check CI status | `squad_workflows_check_ci` | CI must be green — returns actionable failure context if not |
| Pre-merge validation | `squad_workflows_merge_check` | Holistic gate: approvals + threads + CI + changeset + branch current |

### Merge Ceremony

| Step | Tool | Gate |
|------|------|------|
| Merge PR | `squad_workflows_merge` | Squash merge, delete branch, check wave completion |

### Wave Completion Ceremony

When the last issue in a wave merges:

| Step | Tool | Gate |
|------|------|------|
| Check wave progress | `squad_workflows_wave_status` | Reports which waves are complete and releasable |
| Release wave | `squad_workflows_release_wave` | Runs changeset version, closes milestone, posts summary |
<!-- squad-workflows: end -->
