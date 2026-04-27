#!/usr/bin/env python3

import json
import re
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    command = (payload.get("tool_input") or {}).get("command", "")
    dangerous_patterns = [
        r"\brm\s+-rf\s+/\b",
        r"\brm\s+-rf\s+\.\b",
        r"\brm\s+-rf\s+\*\b",
        r"\bsudo\s+rm\s+-rf\b",
    ]

    if any(re.search(pattern, command) for pattern in dangerous_patterns):
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "Blocked destructive remove command. Use a narrower, explicitly justified command instead."
                }
            },
            sys.stdout,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
