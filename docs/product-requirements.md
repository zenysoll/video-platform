# Product Requirements Snapshot

This document captures the current project intent so Claude Code workflows can be checked against the real business goal.

## User Experience
- Private Telegram bot with password gate
- Serious tone, no emoji-style interface language
- Clear button-first UX for non-developers
- Stream creation with guided presets and optional custom parameters
- Users should be able to create multiple independent streams

## Stream Configuration
- Stream name
- Number of videos
- Aspect ratio presets: `9:16`, `16:9`, `1:1`
- Custom width and height
- Sound on or off
- FPS
- Duration in seconds
- Cloudflare R2 bucket selection or creation
- Existing connected bucket selection should be supported alongside new bucket creation

## Output Flow
- Generate prompt
- Render video through LTX-2.3 pipeline
- Upload to Cloudflare R2
- Publish to Telegram channel with prompt text
- Publish through a separate publisher bot that is an admin in the target channel
- Destroy Vast instance after completion

## Scale and Operations
- Multiple parallel streams
- Potentially thousands of videos in one stream
- Avoid repeated prompts and repeated-looking videos across streams
- Keep control plane available continuously
- Make cost impact visible and bounded
- Prefer Cloudflare-hosted control-plane components instead of a separate always-on paid server

## Infrastructure Defaults
- Cloudflare control plane
- Vast.ai on-demand worker instances
- Default preference for RTX 5090
- LTX-2.3 video generation pipeline
- R2 object storage
- Separate publisher bot from control bot
- Prefer reproducible ComfyUI-based worker images for deployment stability
- Worker selection must include sufficient VRAM, system RAM, and disk headroom for model weights, caches, temporary renders, and long batch execution
