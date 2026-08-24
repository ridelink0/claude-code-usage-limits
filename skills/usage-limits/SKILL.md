---
name: usage-limits
description: Check how much of the Claude Code usage limit is left and plan the work to fit inside it. Use before starting anything long, when the 5-hour or weekly limit is getting close, when asked how much usage is left or whether there is enough left to finish, and when asked to work cheaply, burn fewer credits, or stretch the rest of the limit.
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
again. That populates the cache the script reads.

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

**It does not fit.** Say so before starting, in plain words. State that not
all of it can be done in what is left, list what you are doing now and what
you are leaving, and name the wall-clock time the window resets so the user
knows when the rest can happen. Then do the part that fits, properly. Do not
start and hope: half a feature, committed and working, beats a whole one
abandoned mid-edit.

**The window resets first.** If the reset lands before the budget runs out,
the limit is not the constraint. Say that and stop optimising for it.

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

> Weekly is at 16%, 5-hour at 47%, about 75 turns of headroom. This fits easily.

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

When the binding window is under roughly 15 percent, or under about ten turns
of headroom, stop adding work and land what exists:

1. Commit or otherwise save the working state.
2. Write `HANDOFF.md`: what is done, what is next, which files are mid-change,
   what the next session should read first.
3. Say when the window resets, as a clock time and not just a duration, plus
   what to run on the way back in.

A handoff written with ten turns left is worth more than the tenth turn.

## When to skip this skill

Do not run the report on every prompt. Once at the start of a long piece of
work, and again if the job grows or something starts looping. The report costs
a turn, which is the thing it is trying to save.

## Files

| Path | What it is |
| --- | --- |
| `scripts/usage.js` | The report. `--json` for raw fields, `--status` for a one-line readout that skips the transcript scan, `--forecast N` for what an N turn job would cost. |
| `scripts/brief.js` | What the hook runs before each prompt. Not meant to be called by hand. |
| `scripts/lowpower.js` | `status`, `on`, `off`. Restores what it replaced. |
| `references/tactics.md` | Every lever that lowers cost, and why it works. |
| `references/how-it-works.md` | Where the numbers come from and where they are soft. |
