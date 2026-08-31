---
name: usage-limits
description: Check how much usage limit is left in this agent (Claude Code or Codex) and plan the work to fit inside it. Use before starting anything long, when the 5-hour or weekly limit is getting close, when asked how much usage or quota is left, whether there is enough left to finish, whether a job fits before the reset, when to stop and hand off, and when asked to work cheaply, burn fewer credits, or stretch the rest of the limit.
---

# usage-limits

Running out of limit halfway through a job is a scheduling failure, not bad
luck. The numbers are on disk before the work starts. Read them, size the job
against them, and either commit to finishing or cut the job down until it fits.

## 1. Measure

```
node scripts/usage.js
```

Paths here are relative to this skill's own directory, not the project you are
working in. Run them from there, or prefix them with the skill's path.

This works the same in Claude Code and in Codex. The host is detected from the
environment; add `--host codex` or `--host claude` if a machine has both
installed and the wrong one is picked. Everything below applies to both unless
it says otherwise.

It prints the real percentages and reset times from the CLI's own cache, plus
a pace measured from the local session transcripts:

```
  Window           Used   Resets in      Left  Turns left
  5-hour            62%      1h 40m     $46.0         ~88
  weekly            75%       2d 4h     $124         ~240   <- binding

  Recent pace   15 turns in the last hour, $0.164 per turn, effort xhigh
```

`Turns left` is the number that matters. It is the remaining headroom divided
by what a turn has actually been costing over the last hour, on this account,
at this effort level. Add `--json` when you want the raw fields.

If it says no snapshot was found, run `/usage` once in Claude Code and try
again. That populates the cache the script reads. In Codex the equivalent is
`node scripts/usage.js --refresh`, which asks Codex itself for a live reading
instead of using the newest one it happened to write.

`Left` is money, so it only appears under Claude Code. Codex meters a share of
an allowance and never quotes a price, so its report has no money column and
its percentages are exactly what they say they are.

The last line names the plan (Pro, Max 5x, Max 20x, Team, Enterprise) and what
it means for spending. Pro has the least room and the 5-hour window usually
binds first; Max 20x rarely binds at all. Take that line into account before
deciding how careful to be.

## 2. Size the job before starting it

Count the work in turns, not in tasks. A rough scale that holds up in practice:

| Work | Turns |
| --- | --- |
| Read and answer a question about existing code | 1 to 2 |
| One edit plus the check that it worked | 2 to 4 |
| A feature touching three or four files | 10 to 20 |
| Debugging something with an unknown cause | 15 or more, and unpredictable |

Then compare against `Turns left` and hold back a reserve. Reserve about a
fifth of the budget for landing the work: the test run, the commit, and the
handoff note. Work that gets cut off just before the commit is worth nothing,
so the reserve is not optional.

## 3. Decide, out loud

Tell the user which of these applies before doing anything expensive.

**It fits.** Say so with the number, then work normally. Do not slow down out
of caution when there is room. Cheapness is not a virtue when the budget is
not tight.

**It fits only if nothing goes wrong.** Say so, switch to low power for the
run, and reorder the work so the valuable part lands first.

**It does not fit.** Say so in one line before starting, and name the
wall-clock time the window resets so the user knows when the rest can happen.
Then do the whole thing anyway, ordered so that being cut off costs as little
as possible.

That is the part to get right, because the tempting move is the wrong one.
Deciding on the user's behalf to do less of what they asked spends their
request to protect a budget that expires regardless, and they did not ask for
that trade. Scaling the work down is their call, not yours.

So take the whole request, and make a cutoff cheap instead:

- Order it so the most valuable part lands first.
- Save at clean boundaries as you go, rather than once at the end.
- Keep a short running note of what is done, what is next, and which files are
  mid-change, so stopping at any moment loses nothing.

Half a feature, committed and working, still beats a whole one abandoned
mid-edit. The difference is that you get there by sequencing the work, not by
refusing part of it.

**The window resets first.** If the reset lands before the budget runs out,
the limit is not the constraint. Say that and stop optimising for it.

## The budget line ages during a turn

The hook runs when a prompt is submitted, so the figures you were given are
from the start of the turn. A message sent while you are already working does
not fire it again: it arrives without a budget line, and the numbers you are
holding are now older than they look.

That matters most when it is the one thing you are about to assert. Re-check
before saying a job fits, if any of these are true:

- the turn has run long, or through many tool calls
- more requests arrived while you were working
- other sessions are active, so the budget is draining without you

```
node scripts/usage.js --status
```

That is one cheap read of a small file, no transcript scan, and it costs far
less than promising to finish something and stopping halfway. If you have no
budget line at all this turn, you are mid-turn: use the last one you were given
and treat it as a ceiling, not a reading.

## When messages stack up

Every message sent while work is already running starts another turn, and every
turn re-sends the whole conversation. Three follow-ups during one task can cost
more than the task did.

So when several additions arrive while you are still working and the binding
window is tight, say it once, then keep going:

> I have got all three. While the weekly window is this tight, sending them
> together costs a good deal less than one at a time, so I will fold these in
> and carry on. Send the rest in one go if you can.

Four rules keep that from being obnoxious, and they matter more than the saving.

**Ask once per stretch of work.** A second reminder costs more goodwill than
the tokens it saves.

**Only when the budget is actually tight.** With room to spare, asking someone
to hold their thoughts is rude for no gain. Say nothing.

**Never discourage a correction, a stop, or a bug report.** Those are the
messages that save the most work. Someone interrupting to say the approach is
wrong has just paid for their own interruption many times over, and a rule that
trains people out of that is far more expensive than the turns it saves. Only
additive scope, the "also do X" and "and can you Y", is worth batching.

**Never make it about you.** The cost lands on their limit, not yours. Frame it
as their budget, offer the saving, and let them decide. Then work. Do not stop
to negotiate about whether to stop.

## Credits

The `Credits` line in the report says what actually happens at the limit, and
the two cases need opposite handling.

**Off.** Work stops dead at the limit. Nothing spills over. This is the case
to plan hardest around, because there is no way to buy your way through it.

**On.** The limit is a cost boundary rather than a hard stop, so a job that
does not fit can still be finished, for money. Do not warn about the crossover
yourself: Claude Code announces it and asks before drawing on credits, and
repeating that only adds noise. Just factor it into the plan, and take the
user's answer to that prompt as the decision.

## Opening with the budget

Start every reply with one line saying where the budget stands and whether what
was asked fits. The hook puts the numbers in front of you before the prompt, so
there is nothing to go and look up.

When there is room, one line, then get on with it:

> The 5-hour window is the binding one: 47% used, about 75 turns of headroom.
> This fits easily.

When it does not fit, that line becomes the plan:

> The weekly window has about 22 turns left. That covers the parser change and
> its tests, but not the migration or the docs pass, so I will do the first two
> and leave the rest for after the reset at 09:00.

What makes the second one useful is the split, not the percentage. "78% used"
is not something anyone can act on. "This fits, that does not, here is the
order" is.

Keep it to one line unless the work genuinely does not fit. The budget note is
a header, not a section, and it must never push the actual answer down the
page.

Which window binds is about what stops you soonest, not what stopping costs.
Those differ: a 5-hour window comes back in hours, the weekly one in days. So
when a window that is not binding sits near its wall, say so and weigh it. The
hook flags those. Running the weekly out to save a few turns of the 5-hour
window is a bad trade even though the 5-hour is what runs out first.

One thing to get right: **quote the binding window, not the roomiest one.**
Two windows run at once and they are rarely in the same place. The turns of
headroom and the reset time belong to whichever runs out first. Putting the
other window's percentage next to those figures claims far more room than
exists, and that is how a session ends mid-edit while the weekly number still
looks comfortable.

### Pricing the job before starting it

Size the work in turns using the table above, then price it:

```
node scripts/usage.js --forecast 15
```

That converts turns into points of each window using what turns have really
cost on this account, and reports a range rather than a single number, because
a turn that reads three files costs many times one that answers from context.
The upper end is the honest one for a long run, since turns get dearer as the
context grows.

Reach for it whenever the answer to "will this finish" is not obvious.


## 4. Low power

Two halves, and the second one is the half that actually binds.

The setting:

```
node scripts/lowpower.js on              # effortLevel -> low, old value saved
node scripts/lowpower.js on --effort medium --model sonnet
node scripts/lowpower.js off             # restores exactly what was there
```

In a headless run (`claude -p`) there are no slash commands, so the script is
the only lever there.

`effortLevel` is what the `/effort` picker writes. Reasoning is billed as
output tokens, the most expensive tokens in the request, so dropping `xhigh`
to `low` is the largest per-turn saving available without changing model or
scope. The file change applies to new sessions; for the session already
running, `/effort low` takes effect immediately.

Do not take that on trust: the report measures it. Under the model table it
says how much of the output was reasoning and what that cost, for example

```
    Of that output, 74k was reasoning (40%, about $1.85), the part effort controls.
```

That share is the ceiling on what lowering effort can save, so read it before
deciding whether the saving is worth the loss of reasoning. Forty per cent of
output is worth acting on; four per cent is not, and turning effort down for it
would cost more in rework than it saves. The same figure covers reasoning asked
for per prompt, by `ultrathink` or any other means, because it is all the same
spend on the same meter and the transcript does not separate them.

The behaviour, which applies **even at xhigh or max effort**, because the
effort setting does not control any of it:

- Think briefly on routine steps. Save the long reasoning for decisions that
  are actually hard to reverse.
- Send independent tool calls together in one message. Three calls in one turn
  cost one context resend; three separate turns cost three.
- Read line ranges, not whole files. Grep with a head limit. A 40k-token file
  read is not paid once, it is paid again on every later turn in the session.
- Never re-read a file to confirm an edit landed. The edit tool already failed
  if it did not.
- No subagents. A subagent starts cold and re-derives context that is already
  in this session.
- Nothing that was not asked for. No speculative refactor, no extra test, no
  drive-by cleanup.
- Fewer, denser turns. Narration between tool calls is output tokens spent on
  nothing.

`references/tactics.md` has the full list and the billing reasons behind each
one.

## 5. Checkpoint before the wall

When the binding window is under roughly 10 percent, or under about ten turns
of headroom, keep working and start keeping the work landable:

1. Commit or otherwise save the working state, at every clean boundary rather
   than once at the end.
2. Keep `HANDOFF.md` current as you go: what is done, what is next, which files
   are mid-change, what the next session should read first.
3. Say when the window resets, as a clock time and not just a duration, plus
   what to run on the way back in.

The point of the handoff is that it costs almost nothing and removes the reason
to stop early. With one in place, being cut off loses a turn instead of an
afternoon, so there is no longer anything to buy by winding down.

The one thing not to economise on is the handoff itself. Everything else can be
picked up next session; a session that ends without one cannot.

## Running under Codex

Everything above works the same. The numbers come from a different place and
one thing about how they arrive is different, and both are worth knowing.

Codex writes its session rollouts to `~/.codex/sessions`, one JSON object per
line, and every model request appends a record carrying both the account meter
and what that request cost in tokens. So the two things this skill needs, the
percentages and the pace, come out of the same files. Nothing is sent anywhere
and no credentials are read.

```
node scripts/usage.js --host codex
node scripts/usage.js --host codex --refresh
```

`--refresh` asks Codex itself for a live reading instead of the newest one it
happened to write. It starts a short-lived `codex app-server`, takes about a
second, and is the Codex equivalent of running `/usage` in Claude Code. Use it
when the report says the snapshot is old, not routinely.

The difference that matters: **there is no budget line in front of the prompt.**
Claude Code lets a plugin ship hooks, so it gets one automatically. Codex will
not load hooks from a plugin, and on current builds it does not run them from
`~/.codex/hooks.json` or `config.toml` either, so nothing puts the figures in
front of you before you start.

What replaces it is an instruction, installed by:

```
node scripts/install-codex-hook.js on
```

That writes a marked block into `~/.codex/AGENTS.md` saying to run the report at
the start of a substantial piece of work, and it stages the hooks for the build
that runs them. `status` says what is installed, `off` removes both, and neither
touches anything else in those files.

So under Codex, read the budget deliberately rather than waiting to be told it.
Once at the start of a piece of work, and again if the job grows or starts
looping. The rest of this skill applies unchanged.

The report has no money column under Codex. Codex meters a share of an
allowance and never quotes a price, so the percentages are exactly what they
say and there is no dollar figure to attach. `scripts/lowpower.js` is for Claude
Code only: it writes Claude's `settings.json`, so it must not be run under
Codex. Change model or effort through Codex's own controls instead.

## When to skip this skill

Do not run the report on every prompt. Once at the start of a long piece of
work, and again if the job grows or something starts looping. The report costs
a turn, which is the thing it is trying to save.

## Files

| Path | What it is |
| --- | --- |
| `scripts/usage.js` | The report. `--json` for raw fields, `--status` for a one-line readout that skips the transcript scan, `--forecast N` for what an N turn job would cost, `--host codex` to read Codex's limits, `--refresh` to ask Codex for a live figure. |
| `scripts/brief.js` | What the hook runs before each prompt. Not meant to be called by hand. |
| `scripts/pulse.js` | What runs after tool calls, to re-check the budget during a long turn. Not meant to be called by hand. |
| `scripts/host.js` | Works out which agent this is running inside, so one host's percentages are never reported against the other's turns. |
| `scripts/codex.js` | The Codex reader: the meter and the pace out of `~/.codex/sessions`, plus the live `--refresh` call. |
| `scripts/install-codex-hook.js` | `status`, `on`, `off`. Installs the Codex-side instruction, which Claude Code does not need. |
| `scripts/lowpower.js` | `status`, `on`, `off`. Restores what it replaced. Claude Code only. |
| `references/tactics.md` | Every lever that lowers cost, and why it works. |
| `references/how-it-works.md` | Where the numbers come from and where they are soft. |
