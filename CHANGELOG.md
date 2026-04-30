# Changelog

All notable changes to this project will be documented in this file.

## 1.0.0

### Major Changes

- Initial stable release of squad-workflows — issue-to-merge lifecycle orchestration for Squad agents.
- 14 Copilot CLI tools: `init`, `doctor`, `estimate`, `decompose`, `post_design_proposal`, `check_design_approval`, `check_feedback`, `check_ci`, `merge_check`, `merge`, `fast_lane`, `board_sync`, `wave_status`, `status`.
- CLI with 8 commands: `init`, `doctor`, `estimate`, `decompose`, `status`, `wave-status`, `merge-check`, `fast-lane`.
- Wave-based incremental delivery: large features decompose into GitHub milestones with demo criteria.
- Heuristic estimation engine with auto-labeling (`estimate:S/M/L/XL`).
- Design proposal and review ceremony enforcement.
- Pre-merge validation: approvals, threads, CI, changeset checks.
- Fast-lane bypass for `estimate:S` and `squad:chore-auto` issues.
- SKILL.md protocol documentation for agent consumption.
