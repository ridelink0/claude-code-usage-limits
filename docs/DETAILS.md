# usage-limits: the details

The parts of the README that are reference rather than how to use it. The [README](../README.md) is the place to start.

## Budget modes

This plugin is not free. It puts a line into the model's context before every
prompt, refreshes readings after tool calls, and keeps a status line alive. A
mode called "save tokens" that still injects four hundred tokens of advice per
turn is not saving anything - it is charging you for the advice about saving.

So a mode changes two things, not one: what the plugin tells the agent to do,
and what it costs to say it.

```
claude-usage-limits mode                  which one, where it came from
claude-usage-limits mode max              set it
claude-usage-limits mode off --guard 95   off, except one line near the wall
claude-usage-limits mode auto             pick from pressure, always reported
claude-usage-limits mode --list           all four, and the aliases
claude-usage-limits mode --ledger         measured cost per turn, per mode
```

| mode | what it does | what it costs |
| --- | --- | --- |
| `max` | fewest tokens that can still finish the job | one terse line, readings every 10 minutes, silent while nothing a decision depends on has moved |
| `high` | full capability, re-costed every two minutes mid-turn | the normal line, **plus a standing directive on every prompt** (about 650 characters, so a `high` briefing runs roughly 40% longer than `standard`), plus a short re-cost the first time a cheaper tier would do the same job - re-measured every two minutes, said only when the answer changes |
| `standard` | what the plugin has always done | today's line, today's cadences, unchanged |
| `off` | nothing at all | every hook returns before reading anything: no scan, no state write, no line, no end-of-reply tally |

`high` is the mode that spends a little more to waste a lot less: it carries a
standing directive and re-measures mid-turn, so its own line is longer than
`standard`'s. `max` is the one that costs less to say. Picking `high` because
the word sounds efficient and expecting a shorter line is the one
misunderstanding worth heading off.

Aliases, because people ask for these in their own words: `ultra`,
`ultra-efficient`, `maxtoken`, `maxefficient` for `max`; `smart`,
`high-efficient` for `high`; `efficient`, `token-efficient`, `default`, `on`
for `standard`; `none`, `quiet`, `silent`, `ignore` for `off`.

**`normal` is deliberately not an alias.** To some people it means "the plugin
working as usual" (`standard`); to others it means "the plugin stays out of the
way" (`off`). Those are opposite instructions, so guessing is wrong half the
time. Ask for `normal` and you get a question back, not a setting.

`off` means off, including at 100 per cent used. That is what it says and it is
honoured literally - which is also the failure this plugin exists to prevent,
so setting it prints the consequence once and offers `--guard 95`: one short
line when the window is nearly spent, and nothing else, ever. The default guard
is none. Discoverable, not imposed.

The one thing a mode never does is lower the quality of the work. When things
are tight you change the ORDER of the work, never the amount or the quality.
The savings come from ceremony - speculative reads, re-reads, preamble,
subagents nobody needed, workflows that cost more context than they save - and
the directives say that outright, because a model reading "use fewer tokens"
will otherwise quietly decide to skip the hard part. There is a test for it,
and another one that checks the `max` line is never longer than the `standard`
line for the same reading.

### Two planes, and which one is whose

There are two separate things people mean by "change the model":

- **The user plane** is your `settings.json` (`model`, `effortLevel`), the
  `/effort` and `/model` pickers, and `lowpower.js`. It is you saying what you
  want for yourself. The plugin reads it, shows it, and **never writes it on
  its own initiative.** Claude may recommend a change, and make one if you ask;
  it may not make one unasked. There is a test that exercises every mode, every
  alias, `auto`, the bounds and the guard, and then checks `settings.json` is
  byte-identical.
- **The agent plane** is the tier actually running the turn, and the tier of
  everything the turn spawns. That is what costs money, and that is what the
  modes govern.

`claude-usage-limits mode --baseline` shows both side by side. The budget line
now says the tier as well, and where the reading came from, because the number
that decides what a turn costs was the one number the line never printed. It
names the version, not only the family (`opus 5.5/xhigh`, not `opus/xhigh`),
read from the newest assistant message in the session's transcript: a settings
alias such as `opus` cannot say which Opus answered.

When the model running is an older release of a family that has a newer one at
a lower price - Opus 5 or 4.8 against Opus 5.5 ($4/$20, cache reads $0.20
against $0.50), Fable 5 against Fable 5.1 (reads $0.25 against $1) - the brief
says so once per session, with the prices and how many turns the one-off cache
rebuild takes to repay. In Claude Code it offers `/model <id>`, which switches
the session and saves the model as the default for new sessions; elsewhere it
offers the host's own model setting and names no slash command. A relay whose
own `model` is pinned to the older release is named too, since a wake starts
with that `--model` whatever the session switched to. Releases on
either side of the 4.7 tokenizer change are not compared, because a price per
token is not like for like across it. `mode --no-advice` mutes this with the
rest of the advice.

What Claude can genuinely move, stated without embroidery: the model on an
`Agent` call, and the model and effort inside a `Workflow` script. Its own
model and effort it cannot change mid-session - no hook output field exists for
it, on either host - so the plugin names the exact command and leaves it with
you. It does not pretend otherwise.

You can bound what it may suggest:

```
claude-usage-limits mode --floor sonnet/medium   # never point below this
claude-usage-limits mode --ceiling opus/xhigh    # nor above it
claude-usage-limits mode --pin                   # report only, suggest nothing
claude-usage-limits mode --decline               # no, and stop suggesting that
```

And when you say "put it back", there is something to put it back to:

```
claude-usage-limits mode --history   what changed, when, at whose instruction
claude-usage-limits mode undo        reverse the last change, naming it first
```

`undo` reverses what the plugin owns. For a change to your own settings it
names the entry and the command that undoes it and leaves the file alone -
which is the same rule as everywhere else, and the reason the byte-identical
test can never go green by accident.

## How accurate is it

Good enough to plan with, not a bill. The honest caveats:

- The meter reports whole percent, so a reading of 2 percent is really
  somewhere between 1.5 and 2.5. Low readings project badly, and the report
  says so when it is in that range.
- Transcripts are local. Usage from another machine or from claude.ai counts
  against the same limit but leaves no local record, which makes the estimate
  read low.
- The dollar figures are an internal unit used to convert your token mix into
  a percentage of the limit. On a subscription plan you are not billed them.
- Turns left assumes the next turns look like the last hour's. A debugging
  spiral breaks that assumption immediately.
- A model released after this table was written is priced at its family's
  average rate, and the report marks those rows with an asterisk rather than
  passing the guess off as a published price.
- Time of day is not modelled. Anthropic used to shrink the five-hour limit
  during peak hours, but removed that on 6 May 2026 for Pro and Max while
  doubling the limits. If demand-based limits ever return, the numbers here
  follow automatically, because they are calibrated from what your traffic did
  to the meter rather than from an assumption about the clock.
- Subagent transcripts, written under the session's own folder, are read too.
  Their calls count in the money and the tokens and are reported apart from
  the turns, because a turn is one main-thread call.
- The account's own list of limits is read as well as the per-window buckets,
  so a per-model weekly such as `weekly (Fable)` shows up as a window of its
  own, priced from that model's calls alone.
- A per-model weekly only counts against you while you are running that model.
  One at 88 per cent is not your wall if you are working on Opus: nothing you
  do moves it. Those windows are still listed, marked `not in use`, but they
  are never picked as the binding window, never raised as a warning, never a
  reason a forecast says the job does not fit, and never what puts `LOW` on the
  status line. Start using that model and they come straight back. Nothing is
  suppressed unless both sides are recognised: an unknown model in the setting,
  or a weekly scoped to a model this table has never heard of, is treated as
  live, because hiding a limit that can stop the work is worse than showing one
  that cannot.
- The report also says what the room left buys in turns of each model, priced
  from that model's own measured cost per turn, against the window its spend
  lands in. Rows sharing a window are alternatives rather than additions. A
  model that has only ever run as a subagent gets no projected turn count at
  all - its errands are not turns - though what delegating to it has cost is
  still reported. What each model cost is remembered in
  `usage-limits-models.json`, one entry per family, so a session that opens on
  a model it has not run this week still knows its price.
- The turn cost behind "turns of headroom" is a median over at least five
  turns, so one compaction cannot define your pace.
- What a point of a window costs is learned once from the best sample seen and
  remembered, rather than re-derived each time from whatever slice is to hand.
  A thin baseline prices a point badly and every correction built on it
  inherits the error, which is how a window truly at 70 percent once came out
  at 82.
- The cache only refreshes when Claude Code talks to the API, so after a gap it
  can be hours old and its 5-hour window long since rolled over. Dropping that
  window would hide the limit that actually stops short work, so it gets rebuilt
  from your transcripts instead: whatever was spent inside the window the stale
  reading describes equalled its percentage, and that price per point still
  values the window running now. Rebuilt figures are written `~41%` in the
  report and "about 41%" in the before-prompt line, and they say how old the
  snapshot is so you can run `/usage` and replace the estimate with a reading.
- A rebuilt figure only counts what this machine did. If you also worked on
  another device it reads low, which is the dangerous direction, so treat it as
  a floor until you refresh.
- If a rebuild comes out above a full window, it is refused rather than capped.
  Local transcripts only see this machine, so a window mostly spent elsewhere
  makes a point look far too cheap and any live spend divides to hundreds of
  percent. Capping that at 100 would tell someone sitting at half their budget
  that it was gone. The window is reported as unknown instead, with a nudge to
  run `/usage`.

[how-it-works.md](skills/usage-limits/references/how-it-works.md) has the field
names, the formulas, and the rest of it.

## Layout

```
.claude-plugin/plugin.json        plugin manifest, Claude Code
.claude-plugin/marketplace.json   lets the repo serve itself
.codex-plugin/plugin.json         plugin manifest, Codex
agents/openai.yaml                how Codex lists the plugin
skills/usage-limits/SKILL.md      what the agent reads
skills/usage-limits/agents/       how Codex lists the skill
skills/usage-limits/scripts/      usage.js, brief.js, pulse.js, stop.js,
                                  sessionend.js, tally.js, codex.js, host.js,
                                  lowpower.js, install-codex-hook.js,
                                  recommend.js, panel.js, feed.js,
                                  statusline.js, live.js, view.js, bars.js,
                                  activity.js, reading.js, drift.js,
                                  mode.js, voice.js, relay.js, wake.js,
                                  lowpri.js
skills/usage-limits/references/   the longer notes
hooks/hooks.json                  runs brief.js before each prompt, pulse.js
                                  during long turns, stop.js after each reply
                                  and sessionend.js when the session closes
commands/check.md                 the /usage-limits:check command
commands/session.md               the /usage-limits:session command
commands/panel.md                 the /usage-limits:panel command
commands/statusline.md            the /usage-limits:statusline command
commands/usage-mode.md            the /usage-mode command
bin/cli.js                        the npx entry point
tools/sync-version.js             keeps the manifest version in step
tools/test-tempdirs.js            temp directories the suite deletes on exit
vscode/                           the VS Code extension; build.js copies the
                                  scripts into vscode/lib and makes the vsix
test/                             node --test, no dependencies
```

## Tests

```
node --test
```

901 tests over the pricing, the window arithmetic, plan and credit detection,
the status line, the before-prompt line, the mid-turn pulse, the after-reply tally and the session history, job forecasting,
per-project attribution, the Codex reader and its installer, the CLI,
packaging, the settings save/restore, and what Claude Code's own wall-time
features are readable as (/low-priority, the wrap-up note, autoContinueAtUsageLimit).

The budget modes are checked as rules rather than examples: the whole stopping
matrix is walked in every mode (640 lines), `off` must inject nothing at any
percentage and any pressure, the `max` line must never be longer than the
`standard` line for the same reading, no line may tell the agent to do the work
worse, and every mode path, alias, bound and guard is exercised before
`settings.json` is compared byte for byte.
