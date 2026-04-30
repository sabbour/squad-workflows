---
"@sabbour/squad-workflows": minor
---

Tokens are now auto-resolved internally via squad-identity's lease system. The `token` parameter has been removed from all tool schemas — tokens never appear in tool call parameters or chat UI. Also fixed REPO_ROOT resolution (was off by one directory level).
