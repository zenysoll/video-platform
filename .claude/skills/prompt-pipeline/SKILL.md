---
name: prompt-pipeline
description: Design and review the prompt generation system for unique, stable, short-form video output at scale.
---

# Prompt Pipeline

Use this skill for prompt generation, prompt validation, anti-duplication, reroll policy, and generation quality strategy.

## Desired Outcome
- Unique prompts across active and recent streams
- Readable short-form hooks suitable for feed-based video
- Reduced probability of broken anatomy, unreadable motion, or repetitive outputs
- Scalable generation for large batches such as hundreds or thousands of videos

## Required Structure
- `planner`: creates a structured brief with theme, subject, action, environment, lighting, camera, pace, and hook.
- `renderer`: converts the brief into a coherent model-ready paragraph.
- `validator`: rejects or repairs prompts that are vague, overloaded, contradictory, or high-risk.
- `fingerprint`: deterministic uniqueness key to prevent repeats.
- `reroll`: clear policy for changing seed or brief after a failed QA result.

## Quality Rules
- Prefer one clear subject and one readable action.
- Keep camera language specific but not chaotic.
- Keep environments vivid but not crowded.
- Avoid instructions that require too many hands, props, or simultaneous actions.
- Scale prompt detail to the requested duration.
- Use anti-duplication across theme, subject, action, camera, and lighting combinations.

## Review Questions
- What stops duplicate prompts across parallel streams?
- What stops near-duplicate compositions with different wording?
- What happens after a failed render-quality check?
- How are unsafe or low-quality categories filtered?
- How are prompts generated in windows instead of unbounded batches?
