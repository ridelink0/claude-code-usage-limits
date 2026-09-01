# usage-limits

[![npm](https://img.shields.io/npm/v/claude-usage-limits)](https://www.npmjs.com/package/claude-usage-limits)

Most usage tools for Claude Code show **you** the numbers. This one shows them
to **Claude**, before every prompt, and changes what it does about them.

Claude Code already knows how much of your 5-hour and weekly limit is gone. It
caches those numbers locally and will show them if you ask. What it does not do
is notice that the job in front of it is larger than the budget behind it. So
it starts anyway, and stops halfway through an edit.

This puts the budget in front of Claude before your prompt lands, so the reply
opens with the answer instead:

> The weekly window has about 22 turns left. That covers the parser change and
> its tests, but not the migration or the docs pass, so I will do the first two
> and leave the rest for after the reset at 09:00.

Nobody read a chart to get that. The numbers reached the model, not you.

## How this differs from a usage dashboard

There are a lot of good tools that read the same local files this does and draw
you a picture: status lines, menu bar apps, terminal dashboards. They are worth
having, and this is not trying to replace them. The difference is who the
output is for.

| A usage dashboard | This |
| --- | --- |
| Renders numbers for a person to read | Puts numbers in the model's context |
| You notice, then you interrupt | Claude notices, and adjusts on its own |
| Tells you 78 percent is gone | Tells you 22 turns are left, and whether what you asked for fits in them |
| Runs beside Claude Code | Runs inside it, as a skill and a hook |
| Shows what already happened | Says what to do now, and what to drop |

A percentage is a fact about the past. The useful question is whether the thing
you just asked for is going to finish, and answering that needs the request and
the budget in the same place. That place is the model's context, which is where
this puts them.

So: if you want to watch your usage, install a status line. This ships one too.
If you want the thing spending the budget to know it is spending the budget,
that is what this is for.

## What it prints

```
Claude Code usage

  Plan       Claude Pro
  Snapshot   3m old
  Settings   model=opus  effort=xhigh
  Overage    off, work stops at the limit

  Window           Used   Resets in      Left  Turns left
  5-hour            62%      1h 40m    $46.00         ~88   <- binding
  weekly            75%       2d 4h      $124        ~240

  Recent pace   15 turns in the last hour, $0.164 per turn, effort xhigh
  Measured      1,284 turns of local transcript

The 5-hour limit is the binding one. At the current pace it runs out in about
1h 12m, which is 28m short of the reset. Size the work to fit, or slow the burn.
```

`Turns left` is the column that matters. It divides the remaining headroom by
what a turn has actually been costing over the last hour, on your account, at
your effort level, so it moves when your working style does. Fifteen turns of
headroom means something you can plan against; 75 percent does not.

It also breaks the window down by model, with the token split behind it:

```
  Models in the 5-hour window
    Model                   Turns    Tokens   Output   Share
    claude-opus-5             159     27.0M     212k    100%
    Tokens  input 318, cache write 631k, cache read 26.2M, output 212k
```

When more than one project has run inside the window it breaks that down too,
so you can see which working directory actually spent the week:

```
  Projects in the weekly window
    Project                 Turns    Tokens   Share
    ...ideLink-Stuff-app      930     45.2M     78%
    C--Users-OWNER            240     12.1M     22%
```

That split is usually the surprise. Almost all of it is cache reads, billed at
a tenth of the input rate but paid again on every turn, which is why context
length matters more than any single expensive message.

The percentages and reset times come from Claude Code's own cache. The pace
comes from your local session transcripts. Neither requires a network call.

## Install

Nothing to install, if you just want the numbers:

```
npx claude-usage-limits
npx claude-usage-limits --status
npx claude-usage-limits lowpower on
```

That runs the same code as the plugin, from
[claude-usage-limits](https://www.npmjs.com/package/claude-usage-limits) on
npm. Node 18 or newer.

To have Claude read the numbers and plan against them, install it properly.

As a plugin:

```
/plugin marketplace add ridelink0/claude-code-usage-limits
/plugin install usage-limits@usage-limits
```

As a plain skill, if you would rather not use the plugin system:

```
git clone https://github.com/ridelink0/claude-code-usage-limits
cp -r claude-code-usage-limits/skills/usage-limits ~/.claude/skills/usage-limits
```

On Windows, in PowerShell:

```
git clone https://github.com/ridelink0/claude-code-usage-limits
Copy-Item -Recurse claude-code-usage-limits\skills\usage-limits "$env:USERPROFILE\.claude\skills\usage-limits"
```

One difference between the two: the hook that puts the budget line in front of
every prompt is declared in the plugin manifest, so it only runs on a plugin
install. If you took the plain skill and want that behaviour, add it yourself
in `~/.claude/settings.json`, pointing at wherever you put the skill:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/skills/usage-limits/scripts/brief.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Either way, ask something like "how much usage do I have left" or "can we
finish this before the limit hits" and Claude will load it. Installed as a
plugin it also gives you `/usage-limits:check`, which prints the report and
sizes whatever you just asked for against it.

The scripts also run on their own, with or without any of the above:

```
node skills/usage-limits/scripts/usage.js
node skills/usage-limits/scripts/usage.js --json
```

## When another Claude is working too

Two Claude Code windows share one limit, so headroom measured in turns is
optimistic while another session is also spending. It watches for that:

```
  Sharing       2 sessions have spent in the last 15m, splitting this budget 75% / 25%
                The turns above are the whole window, not your slice of it.
```

and the before-prompt line says how many of those turns are actually yours:

```
about 38 turns of headroom (2 sessions active, roughly 10 of them yours)
```

The split comes from measured spend rather than an assumption that everyone is
working equally hard, because they usually are not. A session that has gone
quiet for a quarter of an hour is not counted as competing.

Every session's spend also feeds the reading itself, not just the split. The
percentage is corrected using all spend recorded since the snapshot was taken,
whichever window produced it, so another Claude burning budget in the next
terminal moves your number too.

## Which limit it watches

Two windows run at once and the 5-hour one is usually what actually stops you,
so it gets picked whenever it is tighter, and it wins a tie against the weekly
window because the shorter window is the one hit first in practice.

It is not forced, though. When the weekly window is genuinely the wall, at 99
percent with minutes left, that is what gets reported. Forcing the 5-hour there
would hide the limit about to stop the work, which is the same failure as
ignoring it.

A window with no recent spend to measure is ranked by how full it is rather
than being skipped, so a 5-hour window sitting at 95 percent is never passed
over just because nothing has gone through it in the last few minutes.

Binding is about what stops you soonest, though, not what stopping costs, and
those are different: a 5-hour window returns in hours, the weekly one in days.
So a window above 85 percent gets called out even when something shorter binds,
with its own reset time, because spending the weekly window to save a few turns
of the 5-hour one is a bad trade.

## When you keep typing

Every message sent while work is already running starts another turn, and each
turn re-sends the whole conversation. Three follow-ups during one task can cost
more than the task did.

So when several additions arrive mid-task and the binding window is tight,
Claude says so once and keeps working:

> I have got all three. While the weekly window is this tight, sending them
> together costs a good deal less than one at a time, so I will fold these in
> and carry on.

It asks once, never repeatedly, and only when the budget is actually tight.
Asking someone to hold their thoughts when there is room to spare is rude for
no gain.

The important exclusion: it never discourages a correction, a stop, or a bug
report. Those are the messages that save the most work, and a rule that trains
people out of interrupting to say "that is wrong" costs far more than the turns
it saves. Only additive scope is worth batching.

## Credits, and what happens at the wall

The report says which of two things happens when the plan allowance runs out,
because they need opposite handling.

If paid credits are off, work stops dead and there is no buying through it,
so the report says so and plans around it. If they are on, the limit is a cost
boundary instead of a wall. It deliberately does not warn you about that
crossover, because Claude Code already announces it and asks before drawing on
credits, and a second warning saying the same thing is just noise.

When the binding window will run out before it resets, the report stops
describing and starts instructing:

```
The 5-hour limit is the binding one. At the current pace it runs out in about
20m, which is 3h 40m short of the reset. Size the work to fit, or slow the burn.
  Work stops when it does. Nothing carries on into paid credits.
  Land what exists, write the handoff, and resume after 03:00.
```

The clock time matters more than the countdown. "Resume after 03:00" is a
plan; "4h 12m" is a number you still have to do arithmetic on.

The skill also requires Claude to say up front when a job will not fit in what
is left, name what it is doing now, what it is leaving, and when the rest can
happen, rather than starting and stopping halfway through an edit.

## Releasing

```
npm version patch
git push --follow-tags
```

Pushing the tag runs the tests and publishes to npm. That goes through npm's
trusted publishing over OIDC, so there is no publish token stored in the repo
or in CI. `npm version` also syncs the version in the plugin manifest, so the
marketplace and the npm package never disagree about which release is current.

## Status line

For a permanent readout instead of asking, point Claude Code's status line at
the same script. In `settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/skills/usage-limits/scripts/usage.js --status"
  }
}
```

It prints one line and prefixes `LOW` once a window passes 90 percent:

```
5h 62% 1h 40m  wk 75% 2d 4h
```

`--status` reads only the cached percentages and never opens a transcript, so
it runs in about a tenth of a second and is safe on every redraw. Use the full
path rather than `~` if your shell does not expand it, and point it at the
plugin copy instead if that is how you installed it.

## It tells you where you stand, every time

Installed as a plugin, a hook measures the budget before each prompt and puts
one line into Claude's context:

```
[usage-limits] binding window is 5-hour 47% used, about 75 turns of headroom,
resets in 3h 52m. Other windows: weekly 16%. This session: 229 turns, 14.2M tokens, $64.16.
```

It names the window that will stop the work first and hangs the figures off
that one. Two windows run at once and they are rarely in the same place, so
"weekly 16%" sitting next to "75 turns" would read as far more room than
exists.

Claude opens with it. When there is room that is a single line and it moves on:

> The 5-hour window is the binding one: 47% used, about 75 turns of headroom.
> This fits easily.

When there is not, the line becomes a plan rather than a status:

> The weekly window has about 22 turns left. That covers the parser change and
> its tests, but not the migration or the docs pass, so I will do the first two
> and leave the rest for after the reset at 09:00.

The wording changes with the pressure, not only the numbers. The trigger worth
explaining is pace: two days into a week you should be near 29 percent spent, so
60 percent means you will not last the week, and that is worth hearing at 60
rather than at 85.

One limit worth knowing: the hook fires when a prompt is submitted, so a
message sent while Claude is already working does not refresh it. Claude Code
delivers those into the running turn without re-running hooks, which no plugin
can intercept. The skill handles it by telling Claude the figures age during a
turn, and to re-read them before claiming a job fits rather than trusting a
number from several tool calls ago.

It has to be cheap, because it runs on every prompt. The percentages come from
one small file. The transcript scan behind "turns of headroom" is cached for a
minute, so it costs about 400ms cold and 120ms warm.

| Variable | Default | Effect |
| --- | --- | --- |
| `USAGE_LIMITS_BRIEF` | on | Set to `off` to turn the before-prompt line off entirely. |
| `USAGE_LIMITS_NEAR` | 90 | Percent used at which the budget counts as tight. Nothing below it is discouraged. |
| `USAGE_LIMITS_FEW_TURNS` | 10 | Turns of headroom at or below which the budget counts as tight. |
| `USAGE_LIMITS_RUNWAY` | 10 | Minutes of runway at the current pace below which the budget counts as tight. |
| `USAGE_LIMITS_CACHE` | 60 | Seconds the measured half stays good for. |
| `USAGE_LIMITS_FLOOR`, `USAGE_LIMITS_AHEAD` | 40, 15 | Only feed the reported pace figure; they no longer change the wording. |
| `USAGE_LIMITS_PULSE` | on | `off` silences the mid-turn line; `always` prints it even when there is room. |
| `USAGE_LIMITS_PULSE_SECONDS` | 120 | How often the mid-turn line can fire. |
| `USAGE_LIMITS_TALLY` | on | Set to `off` to turn off the after-reply tally, the closing line and the session history. |

## What a session cost

The other half of the question. After every reply, a `Stop` hook shows you one
line with what that reply cost and what the session has cost so far, tokens
first because that is what people ask:

```
[usage-limits] this reply: 6 turns, 210k tokens, $0.95. This session: 9 prompts,
48 turns, 3.1M tokens (2.9M cache read, 61k output), about $12.40, roughly 31
points of the 5-hour window. Context is now about 130k tokens.
```

It goes to you, not into the context, so it costs the model nothing. It reads
only the bytes of the transcript written since the previous reply, including
any subagent transcripts under the session's own folder, so it takes a few
milliseconds however long the session has run. When the session closes, a
`SessionEnd` hook prints the closing line:

```
[usage-limits] session closed after 1h 42m: 9 prompts, 48 turns, 3.1M tokens, about $12.40.
```

Claude is also asked to end finished work with the total in its own words, one
plain line, and to skip it on partial progress. The before-prompt line carries
the session's tokens, what the last reply cost, and how large the context has
become, with one clause of advice once it passes 150k tokens, because the
context is re-sent on every call and past a point it is the cost of the session.

The history is kept in `usage-limits-sessions.json` beside the other caches:

```
node skills/usage-limits/scripts/usage.js --sessions
node skills/usage-limits/scripts/usage.js --session last
```

```
  Id        When        Project                 Prompts    Turns   Tokens     Cost
  4940f126  9m ago      C--Users-OWNER                1       16     2.8M   $11.36  open
  380e664a  9m ago      C--Users-OWNER               10   112+35    51.0M   $93.11  open
```

`--session last` (or an id, or a unique prefix of one) shows one session in
full: the token split, the model mix, the subagent calls and the context size.
Installed as a plugin, `/usage-limits:session` reads the same thing back.
Turns are main-thread calls; `+N` is what subagents made on top. Set
`USAGE_LIMITS_TALLY=off` to turn all of this off.

If you installed the plain skill rather than the plugin, add the two hooks
beside the first one in `settings.json`: `Stop` running `scripts/stop.js` and
`SessionEnd` running `scripts/sessionend.js`.


## What would this job cost

```
node skills/usage-limits/scripts/usage.js --forecast 15
```

```
Forecast for 15 turns

  Window                 Would cost    Leaves   Verdict
  5-hour               7.4% to 8.4%       45%   fits
  weekly               0.8% to 0.9%       83%   fits

  Priced from 64 recent turns: $0.296 typical, $0.333 at the expensive end.

  There is room for this. No need to work around the limit.
```

It prices turns at what turns have really cost on your account, and gives a
range rather than one number, because a turn that reads three files costs many
times one that answers from context. The upper end is the honest one for a long
run, since turns get dearer as the context grows.


## Plans

It reads which plan you are on and adjusts what it tells you, because the
advice differs even though the arithmetic does not:

| Plan | Read from | What changes |
| --- | --- | --- |
| Pro | `claude_pro` | Smallest budget. The 5-hour window usually binds first. |
| Max 5x | `claude_max` plus `default_claude_max_5x` | Room for Opus on most work. The weekly window is the one that bites. |
| Max 20x | `claude_max` plus `default_claude_max_20x` | Rarely binds. No reason to slow down unless the weekly is already high. |
| Team, Enterprise | `claude_team`, `claude_enterprise` | Seats are pooled and overage is an org setting. |

The window maths never needs to know the plan. It calibrates against what your
own account reports, so it is right on any tier, including ones that did not
exist when this was written. The plan only decides which line of advice you
get at the bottom of the report.

## Codex

It reads Codex's limits too, from the same repo and the same commands.

Codex writes its session rollouts to `~/.codex/sessions`, one JSON object per
line, and every model request appends a record carrying both the account meter
and what that request cost in tokens. That is the same pair of things this tool
needs from Claude Code, so the window arithmetic, the turn estimates, the
forecast and the concurrent-session counting all work unchanged. Nothing is
uploaded and no credentials are read.

```
npx claude-usage-limits --host codex
npx claude-usage-limits --host codex --refresh
npx claude-usage-limits codex-hook on
```

The host is detected, so `--host` is only needed on a machine with both
installed. `--refresh` asks Codex itself for a live reading rather than the
newest one it happened to write; it starts a short-lived `codex app-server` and
takes about a second, and it is the Codex equivalent of `/usage`.

As a plugin, Codex installs it from this repo directly:

```
codex plugin marketplace add https://github.com/ridelink0/claude-code-usage-limits
codex plugin add usage-limits@usage-limits
```

### One thing is different, and it is worth being straight about

Under Claude Code the budget line arrives on its own, because a plugin can ship
hooks. Under Codex it does not, and not for want of trying:

- Codex has the whole hook engine. The binary carries `UserPromptSubmit`,
  `SessionStart`, `PreToolUse` and the rest, and `codex features list` reports
  `hooks` as stable and enabled.
- A plugin cannot ship one: `plugin_hooks` is reported as `removed`.
- And on `codex-cli 0.151.0-alpha.7.2` nothing fires it. Tested with a hook
  whose only job was to write a file, from `~/.codex/hooks.json`, from a
  `[hooks]` table in `config.toml`, and from `~/.codex/hooks/`, in both
  `codex exec` and the desktop app. The engine is present and inert.

So `codex-hook on` installs two things. A marked block in `~/.codex/AGENTS.md`,
which Codex reads at the top of every session and which is what actually works
today; and the hooks themselves, ready for the build that runs them. `status`
reports both, `off` removes both, and neither touches anything else in those
files.

The practical difference is that under Codex the budget is read deliberately,
once at the start of a piece of work, rather than being handed to you before
every prompt.

Two smaller differences. There is no money column: Codex meters a share of an
allowance and never quotes a price, so the percentages stand alone. And
`lowpower` is Claude Code only, because it writes Claude's `settings.json`.

## Where it works

Every surface of Claude Code on a machine shares one config directory, so
this reads all of them and does not care which one you are in:

| Surface | Works | Notes |
| --- | --- | --- |
| Terminal (`claude`) | yes | |
| VS Code extension | yes | |
| JetBrains extension | yes | |
| Desktop app | yes | |
| Headless (`claude -p`) | yes | Scripts run fine, but there are no slash commands, so `lowpower.js` is the only way to change effort. |
| Cloud and web sessions | partly | Those run on a remote machine with their own config directory. Percentages are per-account and stay correct; the pace is measured from whatever transcripts are local to wherever you run the script. |

Sessions from different surfaces land in the same `~/.claude/projects` tree
and are counted together. On this machine the transcripts carry both `cli` and
`claude-vscode` entrypoints, and the report totals both.

Windows, macOS, and Linux all work. `CLAUDE_CONFIG_DIR` is honoured if you have
moved the config directory.

## Working cheaply on purpose

Half the problem is measurement. The other half is that a high effort setting
keeps spending at the same rate whether or not there is room left.

```
node skills/usage-limits/scripts/lowpower.js status
node skills/usage-limits/scripts/lowpower.js on                 # effortLevel -> low
node skills/usage-limits/scripts/lowpower.js on --effort medium --model sonnet
node skills/usage-limits/scripts/lowpower.js off                # puts back what was there
```

It edits `effortLevel` in `settings.json` through a temporary file, saves the
previous values alongside, and keeps a `.usage-limits-backup` copy of the original.
Keys it does not manage are left untouched. Running `on` twice does not
overwrite the saved originals.

The file change applies to new sessions. For a session already running,
`/effort low` does the same thing immediately.

That covers the setting. The larger saving is behavioural, and the skill file
spells it out: batch tool calls, read line ranges instead of whole files, skip
subagents when the context already exists, stop retrying a fix that is not
working. Effort level does not control any of that, which is why those rules
apply even at `xhigh` or `max`. The reasoning behind each one is in
[tactics.md](skills/usage-limits/references/tactics.md).

## Requirements

Node 18 or newer, and a Claude Code recent enough to write
`cachedUsageUtilization` into `~/.claude.json`. If the report says it found no
snapshot, run `/usage` once inside Claude Code and it will be there.

Nothing is uploaded. No API key, token, or credential is read. Everything comes
from files already on the machine.

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
                                  lowpower.js, install-codex-hook.js
skills/usage-limits/references/   the longer notes
hooks/hooks.json                  runs brief.js before each prompt, pulse.js
                                  during long turns, stop.js after each reply
                                  and sessionend.js when the session closes
commands/check.md                 the /usage-limits:check command
commands/session.md               the /usage-limits:session command
bin/cli.js                        the npx entry point
tools/sync-version.js             keeps the manifest version in step
test/                             node --test, no dependencies
```

## Tests

```
node --test
```

308 tests over the pricing, the window arithmetic, plan and credit detection,
the status line, the before-prompt line, the mid-turn pulse, the after-reply tally and the session history, job forecasting,
per-project attribution, the Codex reader and its installer, the CLI,
packaging, and the settings save/restore.

## Status

It works and I use it daily.

What I am not doing is fielding feature requests or support questions. If you
want it to behave differently, fork it and change it, which is what the MIT
licence is there for. Do not wait on me to add something for you.

## License

MIT. See [LICENSE](LICENSE).
