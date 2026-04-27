# Claude Code Research Notes

This file captures the current reasoning behind the starter Claude Code setup in this repository.

## Official Anthropic Guidance Applied
- Keep `CLAUDE.md` concise and limited to facts that matter in every session.
- Move procedures and deep domain playbooks into skills.
- Use hooks for deterministic guardrails rather than repeating hard rules in prompts.
- Use subagents for isolated investigation or specialized review.
- Give Claude a way to verify work instead of relying on self-judgment.
- Manage context aggressively: focused sessions, compaction, and fresh sessions for major topic changes.
- Keep trusted infrastructure and personal exceptions in local settings, not in shared project settings.

## Community and Practitioner Themes
- Engineers consistently report better results with one focused task per session.
- Overly large `CLAUDE.md` files reduce adherence and bury important rules.
- Hooks are valuable for zero-exception safety requirements.
- Claude performs best when success criteria are concrete: tests, screenshots, commands, or diff expectations.
- Long or messy sessions tend to degrade output quality; fresh sessions or compaction help.
- Production work benefits from planning first and implementation second.

## How This Repo Adapts Those Practices
- Root `CLAUDE.md` is intentionally short.
- Skills carry project-domain depth without bloating every session.
- Hooks are used only for deterministic safety nudges and destructive-command protection.
- Subagents are specialized around architecture, backend orchestration, code review, and prompt systems.
- Product requirements are stored separately so implementation can be checked against business intent.
- Local-only templates are provided for personal memory and trusted infrastructure configuration.
