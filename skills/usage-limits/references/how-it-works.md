# Where the numbers come from

Everything is read from local files. Nothing is sent anywhere, and no API key
or token is read.

## Sources

### The limits

`~/.claude.json`, key `cachedUsageUtilization`. Claude Code refreshes this
during normal use, so it is usually a few minutes old at most. The shape:

```json
{
  "fetchedAtMs": 1787522765060,
  "utilization": {
    "five_hour":  { "utilization": 2,  "resets_at": "2026-08-24T02:59:59Z" },
    "seven_day":  { "utilization": 75, "resets_at": "2026-08-23T22:59:59Z" },
    "extra_usage": { "is_enabled": false }
  }
}
```

`utilization` is a whole-number percentage. `resets_at` is when that window
rolls over. Some plans also carry `seven_day_opus` and `seven_day_sonnet`;
the report includes them when they are present.

If the key is missing, run `/usage` once inside Claude Code. That is what
populates it.

The plan name comes from `oauthAccount.organizationType` in the same file.
Current effort and model come from `settings.json` in the config directory.

`CLAUDE_CONFIG_DIR` is honoured if set.

Every surface writes here: the terminal CLI, the VS Code and JetBrains
extensions, and the desktop app all share one config directory, and their
sessions are counted together. Entries carry an `entrypoint` field (`cli`,
`claude-vscode`) if you want to tell them apart, but the report does not
filter on it.

### The pace

`~/.claude/projects/<project>/<session>.jsonl`. One JSON object per line.
Assistant turns carry a usage record:

```json
{
  "type": "assistant",
  "timestamp": "2026-08-23T22:04:56.858Z",
  "requestId": "req_011...",
  "effort": "xhigh",
  "message": {
    "id": "msg_01...",
    "model": "claude-opus-5",
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 8049,
      "cache_read_input_tokens": 24780,
      "output_tokens": 2144,
      "cache_creation": { "ephemeral_1h_input_tokens": 8049 }
    }
  }
}
```

Files whose modification time predates the window are skipped. Turns are keyed
by `message.id` plus `requestId` and counted once, because resuming or forking
a session copies earlier turns into a new file.

## The arithmetic

Each turn is priced at published API rates. Cache traffic is a multiple of the
input rate: 1.25x for a five-minute write, 2x for a one-hour write, 0.1x for a
read.

```
turn        = (input + 0.1*cache_read + 1.25*write5m + 2*write1h) * input_rate
            + output * output_rate

spent       = sum of turns inside the window
per_percent = spent / utilization
left        = per_percent * (100 - utilization)
turns_left  = (100 - utilization) / (recent_cost_per_turn / per_percent)
headroom    = (100 - utilization) / (recent_dollars_per_hour / per_percent)
```

The window opens at `resets_at` minus its span: five hours, or seven days.
Recent pace is measured over the last hour, or since the window opened if that
is more recent.

The self-calibration is the point. Nobody outside Anthropic knows what a
subscription limit is worth in tokens, and it differs by plan. But if 75
percent of the week corresponds to a measurable amount of local traffic, the
remaining 25 percent is worth a quarter of that. The absolute dollar figures
are an internal unit for that ratio. On a subscription plan you are not billed
them, and they should not be read as a bill.

## Where it is soft

**Whole percent granularity.** The meter reports integers, so 2 percent is
really somewhere in 1.5 to 2.5. At low readings the projection can be off by
a quarter or more in either direction. The report flags this below 5 percent.
Above about 20 percent it tightens up considerably.

**One machine only.** Transcripts are local. Usage from another machine, from
claude.ai, or from a cloud session counts against the same limit but leaves no
local record. The percentages stay correct; the calibration reads low, which
makes the remaining headroom look smaller than it is.

**Deleted transcripts.** Same effect. Old session files get cleaned up, and
anything cleaned up inside the seven-day window is invisible to the pace
calculation.

**List prices are a proxy.** The rate table is first-party API pricing. How a
subscription plan actually meters usage is not published, and the weighting
almost certainly is not exactly this. It is close enough for ratios, which is
all it is used for.

**A reset time can be in the past.** The cache refreshes when Claude Code
talks to the API, so an idle spell leaves it behind. A window whose `resets_at`
has passed has already turned over, and its cached percentage describes a
window that no longer exists. Those are marked stale, excluded from the
binding choice, and never used for projections, because treating one as
current would report an empty budget at the exact moment the budget came back.

**Pace is not a promise.** Turns left assumes the next turns look like the last
hour's. A debugging spiral or a large file read breaks that assumption
immediately. Re-run the report if the shape of the work changes.

## Keeping it accurate

The rate table in `scripts/usage.js` is a plain object at the top of the file.
When new models ship, add a row.

Until someone does, a model this table has not seen is priced at the average of
the family its name contains: an unreleased `claude-opus-5-2` is charged at the
mean of every Opus rate on record. Averaging assumes nothing about which
direction prices moved, which is why it beats pinning to whichever release
happened to be newest when the table was written.

A name with no recognisable family falls back to Opus rates. That is a
deliberate choice rather than a neutral one: over-estimating cost understates
your headroom, and being told you have less room than you do is the safe way to
be wrong about a budget.

Rows priced this way are marked with an asterisk in the report, so an assumed
rate never quietly passes for a published one.
