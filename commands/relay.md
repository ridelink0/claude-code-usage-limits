---
description: Carry the current project across the usage reset - arm, check or cancel the automatic pick-up
---

The relay books a one-shot wake a few minutes after the usage window resets and
hands your continuation back then, instead of the work ending when the budget
does. It is off until you turn it on, and it only ever arms while the session
has an unfinished todo list or an approved plan to carry.

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/usage-limits/scripts/relay.js" $ARGUMENTS`
(add `--host codex` under Codex) and read the answer back.

With no arguments that prints the status: whether it is on, where it arms, what
is armed right now, when it wakes, and what the last relay did.

The rest:

- `on` / `off` - the master switch.
- `at 75` - the percentage of the binding window at which a wake is booked.
  Arming costs nothing and does not change the work, so this is deliberately
  well below the wall.
- `grace 5` - minutes after the reset before the wake fires. The reset time is
  when the window opens; a request one second later has been refused before.
- `mode notify` - raise a notification with the continuation ready to open.
  This is the default and it starts nothing by itself.
- `mode resume` - at the wake, resume the same conversation in a window you can
  see, with Remote Control on, so it is also on claude.ai/code and the phone;
  the first prompt points it at the hand-off file. Say `permission acceptEdits`
  (or whichever mode you want) as well: a resume does **not** inherit the
  session's permission mode, so without one it will sit waiting for an
  approval nobody is there to give. `show off` makes it a headless run instead.
- `model <id>` - the `--model` a resumed run starts with; `model` alone goes
  back to the default. It is separate from `/model` in the session, so a wake
  pinned to an older model stays on it until this is changed.
- `voice on|off` - carry how you write in the hand-off, so the resumed session
  answers in your voice without being reminded. On by default.
- `bugcheck on|always|off` - the hand-off asks for two bug passes before anything
  is called done; `always` asks on every prompt as well. On by default.
- `thinking off|resume|always` - `resume` puts the word ultrathink into the
  prompt the relay delivers. `always` sets `alwaysThinkingEnabled` in your
  settings, backs the file up first, and applies to new sessions.
- `arm [--session <id>] ["<text>"]` - arm by hand, against the binding
  window's reset, without waiting for the hook to see a todo list. This is the
  way under Codex, which writes no plan tool into its rollouts for the hook to
  read, and for any project that lives in your head rather than a list. Any
  text given is stored as the continuation.
- `note "<text>"` (or `note --file <path>`) - store the continuation. This is
  the text that gets delivered, so write it to be acted on: what is done, what
  is next in order, which files are mid-change, what to verify first.
- `cancel` - drop the wake and remove the scheduled task.
- `log` - the last twenty lines of what the relay actually did.

If the user asks for something the relay cannot do, say so rather than
approximating it. In particular it cannot type into a terminal or an editor:
Computer Use refuses to send input to a shell on purpose, and the relay uses it
only to tell whether somebody is at the keyboard.

Report the answer and stop. Do not start other work as part of this command.
