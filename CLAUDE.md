# Claude Code Project Memory

## Purpose
- Build a private Telegram-controlled AI video generation platform.
- Optimize for reliability, operator clarity, cost control, and safe automation.
- Prefer production-ready solutions over demos, shortcuts, or hidden magic.

## Always Follow
- Explore first, then plan, then implement for any non-trivial task.
- Give Claude a way to verify its work with tests, commands, screenshots, or expected outputs.
- Treat asynchronous workflows as retryable and idempotent by default.
- Keep expensive logic and secret-bearing logic in the control plane, not on GPU workers.
- Destroy Vast instances after work completes or becomes unrecoverable.
- Never commit secrets or read sensitive local credential files unless explicitly required.

## Repository Guidance
- Keep business logic out of transport handlers.
- Favor explicit schemas, state machines, structured logs, and small modules.
- Update docs and verification steps when behavior changes.
- Prefer concise root instructions; put reusable domain workflows in `.claude/skills/`.

## Product Priorities
- Non-technical operators
- Clear Telegram UX
- Prompt uniqueness across parallel streams
- Stable video quality over novelty spikes
- Predictable costs and recovery behavior

## Use These Skills When Relevant
- `/project-domain` for the product architecture, platform rules, and domain constraints
- `/production-backend` for queues, orchestration, retries, and state machines
- `/prompt-pipeline` for prompt generation, anti-duplication, and output-quality logic
- `/delivery-check` before shipping meaningful changes

## Useful Project Files
- `./.claude/settings.json`
- `./.claude/agents/`
- `./.claude/skills/`
- `./docs/product-requirements.md`
