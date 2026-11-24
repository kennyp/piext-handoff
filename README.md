# piext-handoff

Hand a [pi](https://github.com/earendil-works/pi) session off to a fresh one
before it runs out of room. When a trigger fires, the agent is asked to
finish the step it's on and call `handoff_ready` with instructions for the
next session. When pi settles, a launcher starts the next session (same
folder, same model and thinking level) with them as its first message: a
new Loop tab, tmux window, zellij pane or Rex tab, or whatever your own
script opens.

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
launcher     = "tmux"     # or a list to try in order; unset: the one that fits (see Launchers)
close_old    = "ask"      # yes | no | ask: close this session once the next one runs
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

## Launchers

A launcher is a small executable with three subcommands:

| | |
|---|---|
| `active` | exit 0 if it can start a session from this one, 1 if not (why on stderr) |
| `start` | start the next session; whatever it prints is shown to you (an id, a pane) |
| `close` | close this session's tab or pane; exit 3 if it can't, and pi quits instead |

The handoff comes in as environment variables:

| | |
|---|---|
| `HANDOFF_CWD` | the folder |
| `HANDOFF_PROMPT_FILE` | the first message, in a file |
| `HANDOFF_MODEL`, `HANDOFF_THINKING` | `provider/id` and the thinking level |
| `HANDOFF_PI_CMD` | `pi --model … --thinking … @<prompt file>`, quoted for `sh -c` |
| `HANDOFF_OLD_SESSION`, `HANDOFF_OLD_SESSION_FILE` | this session's id and file |

The built-ins in [`launchers/`](launchers) are short; copy one to start your own.

| | active when | start | close |
|---|---|---|---|
| `loop` | `$LOOP_SESSION_ID` | a new Loop session (AppleScript): `/model`, then the prompt | closes this Loop session |
| `tmux` | `$TMUX` | `tmux new-window` running `$HANDOFF_PI_CMD` | `kill-pane` |
| `zellij` | `$ZELLIJ` | `zellij run` | can't (pi quits) |
| `rex` | `$REX_SESSION` | `rex run` (a new tab) | `rex block close` |
| `file` | always, but only if you name it | copies the prompt to `.pi/handoff-<time>.md` and says how to start it | can't |

**Which one.** `launcher` names one or a list:

- `"tmux"`: a bare name is a script in `~/.config/piext/handoff/launchers/`
  (`tmux` or `tmux.sh`), else a built-in. Yours win: your own `zellij`
  replaces the built-in.
- `"/abs/path"`, `"~/bin/x"`: that file.
- `"./x.sh"`, `"../x"`: relative to the folder of the config that set it
  (`~/.config/piext/`, or the project's `.pi/`).
- `["zellij", "tmux", "./mine.sh"]`: the first that's `active`.

Unset, every launcher (yours and the built-ins, not `file`) is asked, and
exactly one must be `active`. When more than one is (tmux inside a Loop tab,
say), or none is, there's nothing to go on: a trigger only tells you (once,
until pi compacts) and pi compacts as usual, and the agent isn't asked.
`/handoff` shows the launcher in use, or why there's none.

**Only once.** The launch happens when pi settles after `handoff_ready`,
never twice: a second `handoff_ready` before then replaces the instructions,
and after it the agent is told it has already handed off.

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
/handoff go               start the next session now: the agent's instructions, or yours
/handoff cancel           drop a handoff under way
/handoff on | off         automatic handoff for this session
/handoff set <key> <v>    any setting, for this session (no value: unset; launcher takes several)
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
