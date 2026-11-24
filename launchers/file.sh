#!/bin/sh
# piext-handoff launcher: no new session, just the prompt in .pi/ and how
# to start it. Never picked on its own; set launcher = "file" to use it.
#
#   file.sh active   always usable
#   file.sh start    copy the prompt to .pi/handoff-<time>.md; print the command
#   file.sh close    not supported (exit 3)
set -eu

case "${1:-}" in
active) ;;
start)
  mkdir -p "$HANDOFF_CWD/.pi"
  out="$HANDOFF_CWD/.pi/handoff-$(date +%Y-%m-%dT%H-%M-%S).md"
  cp "$HANDOFF_PROMPT_FILE" "$out"
  echo "written to $out; start it with: pi --model $HANDOFF_MODEL --thinking $HANDOFF_THINKING @$out"
  ;;
close)
  exit 3
  ;;
*)
  echo "usage: $0 active|start|close" >&2
  exit 2
  ;;
esac
