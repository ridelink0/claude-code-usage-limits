# runway

A Claude Code plugin that reads how much of your usage limit is left and plans
the work to fit inside it.

Claude Code already knows how much of your 5-hour and weekly limit you have
spent. It caches the numbers locally and shows them when you ask. What it does
not do on its own is notice that the job in front of it is bigger than the
budget behind it, and adjust. This adds that: a report you can act on, and a
set of rules for what to do when the answer is "not enough".

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

The percentages and reset times come from Claude Code's own cache. The pace
comes from your local session transcripts. Neither requires a network call.

## Install

As a plugin:

```
/plugin marketplace add ridelink0/claude-code-runway
/plugin install runway@runway
```

As a plain skill, if you would rather not use the plugin system:

```
git clone https://github.com/ridelink0/claude-code-runway
cp -r claude-code-runway/skills/runway ~/.claude/skills/runway
```

On Windows, in PowerShell:

```
git clone https://github.com/ridelink0/claude-code-runway
Copy-Item -Recurse claude-code-runway\skills\runway "$env:USERPROFILE\.claude\skills\runway"
```

Either way, ask something like "how much usage do I have left" or "can we
finish this before the limit hits" and Claude will load it.

The scripts also run on their own, with or without any of the above:

```
node skills/runway/scripts/usage.js
node skills/runway/scripts/usage.js --json
```

## Working cheaply on purpose

Half the problem is measurement. The other half is that a high effort setting
keeps spending at the same rate whether or not there is room left.

```
node skills/runway/scripts/lowpower.js status
node skills/runway/scripts/lowpower.js on                 # effortLevel -> low
node skills/runway/scripts/lowpower.js on --effort medium --model sonnet
node skills/runway/scripts/lowpower.js off                # puts back what was there
```

It edits `effortLevel` in `settings.json` through a temporary file, saves the
previous values alongside, and keeps a `.runway-backup` copy of the original.
Keys it does not manage are left untouched. Running `on` twice does not
overwrite the saved originals.

The file change applies to new sessions. For a session already running,
`/effort low` does the same thing immediately.

That covers the setting. The larger saving is behavioural, and the skill file
spells it out: batch tool calls, read line ranges instead of whole files, skip
subagents when the context already exists, stop retrying a fix that is not
working. Effort level does not control any of that, which is why those rules
apply even at `xhigh` or `max`. The reasoning behind each one is in
[tactics.md](skills/runway/references/tactics.md).

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

[how-it-works.md](skills/runway/references/how-it-works.md) has the field
names, the formulas, and the rest of it.

## Layout

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   lets the repo serve itself
skills/runway/SKILL.md            what Claude reads
skills/runway/scripts/            the two scripts
skills/runway/references/         the longer notes
test/                             node --test, no dependencies
```

## Tests

```
node --test
```

36 tests over the pricing, the window arithmetic, and the settings
save/restore.

## Status

Finished. It does what I built it for, and I am not planning further updates:
no new features, and issues or pull requests will most likely sit unanswered.
It is MIT licensed, so fork it and take it wherever you want.

## License

MIT. See [LICENSE](LICENSE).
