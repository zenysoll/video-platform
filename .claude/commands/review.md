---
description: Review changes with a production-readiness mindset
argument-hint: [diff, files, or scope]
---

Review the current changes with a senior production-readiness mindset.

Focus order:
- correctness
- regressions
- concurrency hazards
- security issues
- cost leaks
- missing tests
- weak observability

Instructions:
- Read the relevant diff and impacted files.
- Prioritize findings over praise.
- For each finding, explain impact, triggering condition, and recommended fix.
- If there are no findings, say so clearly and list residual risks or blind spots.

Scope:
$ARGUMENTS
