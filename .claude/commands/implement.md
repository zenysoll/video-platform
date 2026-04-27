---
description: Implement a task to production quality with verification
argument-hint: [task or scope]
---

Implement the requested task to production quality.

Execution rules:
- Inspect relevant files before editing.
- Keep changes minimal but complete.
- Update documentation or schemas when behavior changes.
- Run the smallest meaningful verification after changes.
- Summarize exactly what changed, how it was verified, and any remaining risks.
- If the request affects infrastructure, queues, billing, orchestration, or secrets handling, review those paths explicitly.

Task:
$ARGUMENTS
