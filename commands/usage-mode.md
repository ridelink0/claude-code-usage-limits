---
description: Show or set the budget mode - how hard the plugin leans, and what it costs to say it
---

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/usage-limits/scripts/mode.js" $ARGUMENTS`
and report the answer back. Then stop; do not start other work as part of this
command.

The plugin is not free. It puts a line into your context before every prompt,
refreshes readings after tool calls, and keeps a status line alive. A mode
changes two things at once: what the plugin tells you to do, and what it costs
to say it.

| mode | what it is |
| --- | --- |
| `max` | fewest tokens that can still finish the job: one terse line, readings every ten minutes, silent when nothing a decision depends on has moved |
| `high` | full capability, re-costed every two minutes mid-turn: the normal line plus a directive to keep checking whether the tier is bigger than the task. The mid-turn re-cost is re-measured on that cadence and said only when the answer changes |
| `standard` | what the plugin does today, unchanged |
| `off` | nothing is injected at all, and every hook returns before reading anything - including the end-of-reply cost line and the closing line |

Aliases: `ultra`, `ultra-efficient`, `maxefficient` and friends for `max`;
`smart`, `high-efficient` for `high`; `efficient`, `token-efficient`,
`default`, `on` for `standard`; `none`, `quiet`, `silent`, `ignore` for `off`.

**`normal` is deliberately not an alias for either `standard` or `off`.** To
some people it means "the plugin working as usual" and to others "the plugin
stays out of the way", and those are opposite instructions. The script answers
it with a question. Ask which was meant; never guess.

Commands:

- (no arguments) - the current mode, where it came from, and what it changes.
- `<name>` - set it. `<name> --session --session-id <id>` sets it for one
  session only.
- `auto` / `auto off` - pick from pressure. Under 50 per cent used it is
  standard, 50 to 79 high, 80 or over (or tight, or gone) max. It is always
  reported as what it resolved to (`auto -> max`) and it never picks `off`.
- `off --guard 95` - off, except one short line when the window is nearly
  spent. `off` on its own is silent even at 100 per cent; that is what it means
  and it is honoured literally, so the guard exists and is offered once.
- `--list`, `--explain <name>` - the modes, and one mode's full record.
- `--floor sonnet/medium`, `--ceiling opus/xhigh`, `--pin` - the user's own
  bounds on what the plugin may suggest. `--pin` means report only: the gap
  between the baseline and what is running is stated and nothing is suggested.
- `--baseline` - the user's own setting and the tier actually running, side by
  side.
- `--advice` / `--no-advice` / `--advice-on` - the recommendation channel.
- `--decline [id]` - the user said no. That recommendation is remembered as
  declined and is never raised again, in this session or any later one. With no
  id it declines whatever is pending.
- `--history`, `undo` - what changed, when, at whose instruction; and reverse
  the last one, naming it first.
- `--ledger` - measured turns and cost per turn, per mode, from what replies
  actually cost.

Two rules that hold in every mode:

1. **The modes govern the agent plane only.** `settings.json`, `/effort`,
   `/model` and `lowpower.js` are the user's own baseline. The plugin reads
   them, shows them, and never writes them on its own initiative. Recommend a
   change freely; make one when asked; never make one unasked.
2. **A mode never lowers the quality of the work.** The savings come from
   ceremony - speculative reads, re-reads, preamble, subagents nobody needed -
   and never from doing the job less well.
