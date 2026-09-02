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

The same object carries a `limits` array: one entry per limit the account
enforces, each with `kind` (`session`, `weekly_all`, `weekly_scoped`),
`percent`, `severity`, `resets_at`, `is_active`, and for the scoped weeklies
which model they cover. The report reads it too. A scoped weekly becomes a
window of its own, labelled `weekly (Fable)` and priced from that model's
calls alone; `is_active` breaks ties in the binding choice; and a bucket that
quotes `limit_dollars` is priced from that directly instead of being calibrated.

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

Subagents write their own transcripts under
`<project>/<session id>/subagents/agent-*.jsonl`, with `isSidechain: true` and
the parent's `sessionId`. They are read too: their calls count in the money and
the tokens, and are kept apart from the turns, because a turn is one main-thread
call. Lines from a model called `<synthetic>` are interrupts and client-side
errors, not calls, and are skipped.

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

**Two files can claim to be the account state.** The meter lives in
`~/.claude.json`, but a Claude Code migration also writes a small
`~/.claude/.claude.json` holding machine ids and no meter at all. Whichever
one actually carries `cachedUsageUtilization` is the one read. Choosing on
existence alone found the stub, concluded there was no Claude snapshot, and
sent host detection off to Codex, which reported that agent's meter inside a
Claude session.

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
all it is used for. No published or community source shows the meter weighting
models differently from their dollar prices, so calibrating dollars against
your own meter remains the best method anyone outside Anthropic has.

**The snapshot is slow by design.** The percentages come from Claude Code's
own cache of the account meter, which refreshes on its own schedule - roughly
hourly in practice, because the endpoint behind it rate-limits aggressive
polling. Between refreshes every figure here is the last real reading plus
arithmetic. That is why an old snapshot is reported as a floor with its age
attached rather than dressed up as a current percentage, and why `/usage` is
the one way to force a fresh reading.

**A reset time can be in the past.** The cache refreshes when Claude Code
talks to the API, so an idle spell leaves it behind. A window whose `resets_at`
has passed has already turned over, and its cached percentage describes a
window that no longer exists. Those are marked stale, excluded from the
binding choice, and never used for projections, because treating one as
current would report an empty budget at the exact moment the budget came back.

**Time of day is not modelled, and does not need to be.** Anthropic used to
shrink the Claude Code five-hour limit during peak hours, so the same work cost
more of it in the afternoon. That ended on 6 May 2026, when the five-hour
limits were doubled and, in Anthropic's words, they removed "the peak hours
limit reduction on Claude Code for Pro and Max accounts". So there is no
peak-hour penalty to model today.

If one ever returns, nothing here needs changing. Every figure is calibrated
from what your own traffic actually did to the meter, so if a point of budget
starts costing more at four in the afternoon, the measured dollars-per-point
moves with it and the headroom follows. That is the advantage of measuring
rather than assuming: the tool does not need to know why a point got dearer.

**One turn is not a pace.** The turn cost behind "turns of headroom" is the
median of a sample, not the mean, and never from fewer than five turns. A
compaction or a large file read can cost ten times an ordinary turn, and one of
those landing in a thin sample once put a window that was 13 percent full at
nine turns remaining. Thin samples widen to the whole window, and then to
everything on record.

**Pace is not a promise.** Turns left assumes the next turns look like the last
hour's. A debugging spiral or a large file read breaks that assumption
immediately. Re-run the report if the shape of the work changes.

## Keeping it accurate

The rate table in `scripts/usage.js` is a plain object at the top of the file.
When new models ship, add a row.

A bracketed suffix on a model id (`claude-sonnet-5[1m]`) is stripped before
the lookup: it marks a context-window variant of the same model, not a new
one. Cache reads price at a tenth of the input rate unless a row carries a
`cacheRead` figure of its own - Fable and Mythos 5.1 price reads outright at
$0.25 per million, far under the tenth rule, and reads are the dominant input
in exactly the long sessions where the difference matters.

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
