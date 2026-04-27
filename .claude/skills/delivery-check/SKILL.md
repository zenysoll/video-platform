---
name: delivery-check
description: Final pre-ship review for reliability, correctness, observability, cost, and security.
disable-model-invocation: true
---

Run a pre-ship review for: $ARGUMENTS

Checklist:
1. Confirm requirement coverage.
2. Confirm state transitions and failure modes are handled.
3. Confirm retries and idempotency on async paths.
4. Confirm logs and identifiers are sufficient.
5. Confirm secrets are protected.
6. Confirm cost-impacting lifecycle steps are explicit.
7. Confirm docs and verification steps are updated.

Return:
- readiness verdict
- blockers
- residual risks
- recommended next actions
