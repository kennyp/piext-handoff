#!/bin/sh
# piext-handoff launcher: a new zellij pane.
#
#   zellij.sh active   exit 0 when this pi runs inside zellij
#   zellij.sh start    open a pane running $HANDOFF_PI_CMD
#   zellij.sh close    not supported (exit 3): piext-handoff quits this pi instead
set -eu

case "${1:-}" in
active)
  [ -n "${ZELLIJ:-}" ] || { echo "not in zellij (no ZELLIJ)" >&2; exit 1; }
  command -v zellij >/dev/null || { echo "zellij isn't on PATH" >&2; exit 1; }
  ;;
start)
  zellij run --cwd "$HANDOFF_CWD" --name pi -- sh -c "$HANDOFF_PI_CMD"
  ;;
close)
  exit 3
  ;;
*)
  echo "usage: $0 active|start|close" >&2
  exit 2
  ;;
esac
