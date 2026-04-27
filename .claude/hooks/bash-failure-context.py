#!/usr/bin/env python3

import json
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    command = (payload.get("tool_input") or {}).get("command", "")
    error = payload.get("error", "")

    message = (
        "A bash command failed. Stop and diagnose the root cause before trying another fix. "
        "Do not remove features, bypass checks, or stack shallow retries. "
        f"Failed command: {command}. Error: {error}"
    )

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUseFailure",
                "additionalContext": message
            }
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
