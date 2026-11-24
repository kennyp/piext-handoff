#!/bin/sh
# piext-handoff launcher: a new tmux window.
#
#   tmux.sh active   exit 0 when this pi runs inside tmux
#   tmux.sh start    open a window running $HANDOFF_PI_CMD; print its pane id
#   tmux.sh close    kill this pi's pane
set -eu

case "${1:-}" in
active)
  [ -n "${TMUX:-}" ] || { echo "not in tmux (no TMUX)" >&2; exit 1; }
  command -v tmux >/dev/null || { echo "tmux isn't on PATH" >&2; exit 1; }
  ;;
start)
  tmux new-window -P -F '#{pane_id}' -c "$HANDOFF_CWD" "$HANDOFF_PI_CMD"
  ;;
close)
  tmux kill-pane -t "${TMUX_PANE:?}"
  ;;
*)
  echo "usage: $0 active|start|close" >&2
  exit 2
  ;;
esac
