---
name: production-backend
description: Production backend workflow for queues, orchestration, retries, state machines, persistence, and secret-safe service boundaries.
---

# Production Backend Workflow

Use this skill when implementing or reviewing backend code that touches orchestration, queues, workers, persistence, billing, or external APIs.

## Workflow
1. Identify the domain entities and state transitions.
2. Define request, event, and persistence schemas before writing handlers.
3. Make the happy path explicit.
4. Add retry, timeout, idempotency, and cancellation behavior.
5. Add logs and identifiers that make failures reconstructable.
6. Verify the implementation with the smallest meaningful test or command.

## Checklist
- Are handlers idempotent?
- Can duplicate events arrive safely?
- Can a partial failure be retried?
- Are secrets kept out of logs and worker payloads?
- Is there a bounded retry policy?
- Is there a dead-letter or terminal failure state?
- Is there an operator-readable state or audit trail?
- Does the code avoid mixing transport concerns with domain logic?

## Anti-Patterns
- Implicit state transitions
- Silent fallback behavior on infrastructure paths
- Unbounded retries
- Queue payloads without versioning or schema checks
- Business logic spread across Telegram handlers and worker scripts
