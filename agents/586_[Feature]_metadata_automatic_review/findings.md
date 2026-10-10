# Findings
Embedded-tag parsing does not prove catalog completeness. Existing force retrieval does not filter tag_scanned, but completed search jobs and the generic queue gauge are misleading. Ambiguous searches currently lose candidate review.
Reference: https://xiers-organization.gitbook.io/music-tag-web-v2
The official introduction documents asynchronous tasks and automatic metadata organization for new directories. Implementation will reuse the existing work pool and configured providers, preserve known fields and album identity, and hold ambiguous/no-match outcomes for user choice.
Use one opt-in automatic service setting, bounded chronological catalog scan and insert-only automatic dispatch. Manual force dispatch preserves unresolved review. Review selections reuse source/snapshot fences; no-match remains incomplete even after a search finishes.
Browser pending fixture found a real source-path recovery error: a root-level filename was used as album metadata, creating a false known constraint and filtering both plausible candidates. Restrict root album recovery to paths with an actual parent directory and verify root singles plus existing nested albums.
