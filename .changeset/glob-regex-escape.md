---
"@sabbour/squad-workflows": patch
---

fix(workflow-config): escape regex metacharacters in glob matcher (backport from kickstart)

The `matchGlob` helper was constructing a `RegExp` by naively replacing `**`
and `*` placeholders without first escaping regex metacharacters (`.`, `+`,
`(`, `[`, etc.) in the literal path segments.  This meant that a pattern like
`**/*.md` would incorrectly match `path/to/READMExmd` because the unescaped
`.` acted as a wildcard inside the `RegExp`.

Fix: split each glob segment on the wildcard tokens, escape every literal
sub-segment with `s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')`, then rejoin with
the appropriate regex equivalent (`[^/]*` for `*`, `.*` for `**`).
