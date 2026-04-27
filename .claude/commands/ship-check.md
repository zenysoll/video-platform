---
description: Run a pre-ship readiness checklist for the current work
argument-hint: [feature, branch, or scope]
---

Prepare a pre-ship readiness check for the current work.

Checklist:
- confirm requirements coverage
- confirm migrations and schemas are aligned
- confirm logs and metrics are adequate
- confirm retries and idempotency on async paths
- confirm secrets are not exposed
- confirm docs are updated
- confirm verification steps and deployment notes

Return:
- readiness verdict
- blocking issues
- recommended next actions

Scope:
$ARGUMENTS
