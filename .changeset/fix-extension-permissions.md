---
"@sabbour/squad-workflows": patch
---

Fix extension tool permissions

- Add `skipPermission: true` to all 16 tool definitions to prevent "Permission denied" errors in Copilot CLI
