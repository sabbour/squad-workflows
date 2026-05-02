---
"@sabbour/squad-workflows": minor
---

Improve upgrade and doctor experience:

- `upgrade` now displays a clear `from → to` version transition and detects no-op upgrades (already on latest), including when patching workflows in the repo.
- Managed workflow blocks are now stamped with the installed version, enabling drift detection.
- `setup` reports the version transition consistently with the rest of the squad family.
