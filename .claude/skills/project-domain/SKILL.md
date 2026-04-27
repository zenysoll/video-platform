---
name: project-domain
description: Product and system rules for the private Telegram, Vast.ai, Cloudflare R2, and LTX-2.3 video platform. Use for architecture, implementation, reviews, and tradeoff decisions in this repository.
---

# Project Domain

## Product Summary
- This project is a private Telegram-operated AI video generation service.
- Users authenticate in a Telegram bot, configure a stream, launch it, and receive generated videos published to a Telegram channel.
- The audience is non-technical. UX must be serious, clear, and button-driven.

## Required Product Behavior
- Password-gated access to the control bot.
- Guided stream creation with presets and custom video parameters.
- Parameters include stream name, number of videos, aspect ratio or custom size, sound on or off, FPS, and duration.
- Bucket selection or creation for Cloudflare R2 from the bot flow.
- Automatic launch of a Vast.ai instance per stream, with the pipeline installed and started automatically.
- Automatic upload of completed videos to R2.
- Automatic publication of each video to a Telegram channel where the publisher bot is an admin, along with the prompt text.
- Automatic destruction of the Vast instance after the stream completes or is unrecoverable.
- The control plane must remain available continuously, ideally without requiring a separate paid always-on VM.
- The interface tone must remain serious, clear, and non-technical.

## Architectural Defaults
- Control plane lives outside the GPU worker.
- GPU worker does rendering, local validation, upload, and completion signaling only.
- Use LTX-2.3, not speculative model names.
- Prefer ComfyUI-based or otherwise reproducible worker images for LTX deployment.
- Use on-demand Vast instances, not interruptible, for production execution.
- Default target GPU is RTX 5090 with fallback selection logic when unavailable.
- Separate control bot and publisher bot responsibilities.

## Prompt System Rules
- Prompts must be unique across active streams and recent history.
- Use structured planning before rendering final prompts.
- Favor short-form social-video hooks without surreal or broken anatomy.
- Avoid overloaded scenes, extra limbs risk, excessive choreography, crowded casts, and contradictory camera instructions.
- For large runs, plan prompts in windows or batches rather than creating all prompts at once.

## Reliability Rules
- Every stream and job must have an explicit state machine.
- Queue consumers and event handlers must be idempotent.
- The publish path must be rate-limited and queued separately from rendering.
- Failures must preserve auditability: user, stream, job, instance, and cost context should always be traceable.

## Cost Rules
- Vast cost must stop by destroy, not stop.
- The bot should present expected cost before launch when feasible.
- Cloudflare cost should be surfaced when storage, queue operations, or worker usage can exceed free-tier assumptions.
- No hidden always-on paid compute should be introduced for the control plane without an explicit decision.

## Security Rules
- Keep Telegram control and publisher tokens out of GPU workers.
- Prefer scoped or temporary credentials for storage operations.
- Secrets must not leak into prompts, logs, manifests, or channel posts.
