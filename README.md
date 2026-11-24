# piext-handoff

Hand a [pi](https://github.com/earendil-works/pi) session off to a fresh one
before it runs out of room. When a trigger fires, the agent is asked to
finish the step it's on and call `handoff_ready` with instructions for the
next session; the next session (same folder, same model and thinking level)
starts with them as its first message.

## Install

```sh
pi install ./piext-handoff     # or add the path to "packages" in ~/.pi/agent/settings.json
```

It does nothing on its own until a config sets `enabled = true`;
`/handoff` works either way.

## Configuration

The `[handoff]` table of the shared piext settings
([piext-config](https://github.com/kennyp/piext-config)):
`~/.config/piext/config.toml`, then the folder's `.pi/piext.toml`, then the
session's own (`/handoff set`).

```toml
[handoff]
enabled      = true       # false (the default): only /handoff starts one
threshold    = 0.75       # share of the context window in use; 0 = off
turns        = 0          # prompts in the session; 0 = off
on_compact   = true       # cancel pi's automatic compaction and hand off instead
mode         = "auto"     # auto | ask (you see, and can edit, the prompt first)
launcher     = "replace"  # replace | loop-tab | file
close_old    = false      # loop-tab: close this Loop session afterwards
remind_after = 3          # prompts to wait for handoff_ready before one reminder

[handoff.models.opus]
name      = "*opus-5-5"   # a pattern, or a list of them
threshold = 0.6

[handoff.models.local]
name    = ["ollama/*", "*:free"]
enabled = false           # these models hand off only when you ask
```

**Settings for a model.** General keys from every level apply first, then
the model table that fits best, from every level: a model table beats the
general keys even of a later level. Patterns match `provider/id` or just
`id`, regardless of case; `*` and `?` match anything (slashes too), and a
pattern without them matches anywhere in the name (`"opus"` is `*opus*`).
Several tables fit: the most specific wins (most literal characters), then
the first. A table without `name` matches by its key. Settings are worked
out again whenever you switch models.

**Triggers.** `threshold`, `turns` and `on_compact` are separate; the first
to fire asks the agent, once. `on_compact` only stops pi's own threshold
compaction: `/compact` and overflow recovery go ahead. If the agent hasn't
handed off `remind_after` prompts later it's reminded; if it still hasn't,
pi compacts as usual and the next trigger asks again.

**Launchers.**

| | |
|---|---|
| `replace` | a new session in this pi (`ctx.newSession`): same folder, same Loop tab or terminal; the old session is its parent |
| `loop-tab` | a new Loop session in a new tab (AppleScript), optionally closing this one; outside Loop it falls back to `file` |
| `file` | writes `.pi/handoff-<time>.md` and tells you how to start it (`pi --model … @file`) |

## The agent's side

`handoff_ready {instructions, summary?, files?, include_tasks?}`. The first
message of the next session holds the instructions, the summary, the files,
the open tasks (from piext-tasks, unless `include_tasks = false`), the
folder, the branch and the old session's file (for anything the
instructions leave out).

## /handoff

```
/handoff                  settings in effect, where each came from, how close the triggers are
/handoff now [note]       ask the agent to get ready (works when disabled)
/handoff go               start the next session: the agent's instructions, or yours
/handoff cancel           drop a handoff under way
/handoff on | off         automatic handoff for this session
/handoff set <key> <v>    any setting, for this session (no value: unset)
/handoff save local|global
```

`/handoff save` writes this session's settings (or, without any, the ones
in effect) to `.pi/piext.toml` or `~/.config/piext/config.toml` as a table
for exactly this model, `[handoff.models.<id>]` with `name = "provider/id"`,
and opens the file ($VISUAL or $EDITOR if it's a windowed editor, else the
system's text editor) so you can widen the name.

## Events

piext conventions (piext-loop's README has them all). This one:

| Channel | Payload | When |
|---|---|---|
| `piext:hello` / `piext:bye` | `{name, version, provides: ["handoff"]}` / `{name}` | session start (and on `piext:who`) / shutdown |
| `handoff:changed` | `{cwd, state}` | its state changed |
| `handoff:requested` | `{cwd, reason}` | the agent was asked to get ready |
| `handoff:ready` | `{cwd, prompt}` | the agent called `handoff_ready` |
| `handoff:launched` | `{cwd, launcher, model}` | the next session is starting |

## Development

```sh
git submodule update --init && npm install && npm test
```
