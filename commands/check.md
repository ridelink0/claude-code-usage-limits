---
description: Report how much Claude Code usage limit is left and how many turns of work it buys
---

Run the usage report and read it back to me.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/usage-limits/scripts/usage.js"`.
2. Tell me which window is binding, how many turns of headroom is left, and
   whether that window resets before the budget runs out.
3. If I have already said what I want built, size it against the turns left
   and say whether it fits. If it does not fit, say what to cut rather than
   starting and hoping.

Report the numbers and stop. Do not start other work as part of this command.
