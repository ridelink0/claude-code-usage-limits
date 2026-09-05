# Claude Usage Limits for VS Code

The Claude Code extension only shows your usage limits when you ask with
`/usage`. This puts them where you can see them: a view that sits directly
under the Claude Code chat in the secondary side bar, and a status bar item.

Current session (the 5-hour window), current week, and the week for the model
in use when your plan caps that model on its own. Bars turn yellow at 80
percent and red at 90. While Claude is working the title shimmers; under
ultracode it goes rainbow. A Sessions list shows every Claude on the machine
and which of them are working.

The numbers are the ones Claude Code uses: the same call `/usage` makes, with
the login Claude Code already holds, plus the rate-limit headers on Claude's
own responses when the plugin's status line is installed. The token is read for
that one request and sent nowhere else; turn `claudeUsageLimits.fetch` off to
stay on the reading already on disk.

Part of [claude-usage-limits](https://github.com/ridelink0/claude-code-usage-limits),
the Claude Code plugin that puts the same numbers in front of Claude before
every prompt so it plans the work to fit.

## Install

From the Marketplace, or from the `.vsix` on the
[releases page](https://github.com/ridelink0/claude-code-usage-limits/releases):

```
code --install-extension claude-usage-limits-1.11.0.vsix
```

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `claudeUsageLimits.fetch` | true | Take live readings from Anthropic's usage endpoint. |
| `claudeUsageLimits.pollSeconds` | 60 | Seconds between readings. Never under 15. |
| `claudeUsageLimits.statusBar` | true | Show the percentages in the status bar. |

Respects `CLAUDE_CONFIG_DIR`, Claude Code's `timeFormat`, and reduced-motion.
