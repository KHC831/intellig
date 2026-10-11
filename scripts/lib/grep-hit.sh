# ============================================================
# grep-hit.sh — split one `grep -n` / `git grep -n` output line.
# SOURCE this file; do not run it.
#
# A hit reads `<file>:<line>:<text>`. Splitting it at the first colon breaks
# on Windows, where Git Bash prints an absolute path with its drive letter
# (`D:\a\repo\src/x.ts:12:text`): the file becomes `D` and the line number
# becomes the rest of the path. Every guard that parses grep output splits
# through here (scripts/check-script-host-paths.mjs fences that).
#
# Usage: split_grep_hit "$hit"
#   Sets HIT_FILE, HIT_LINE and HIT_TEXT. The text keeps any colons of its own.
split_grep_hit() {
  local hit="$1" drive="" rest
  case "$hit" in
    [A-Za-z]:[\\/]*)
      drive=${hit:0:2}
      hit=${hit:2}
      ;;
  esac
  HIT_FILE="$drive${hit%%:*}" # script-path-exempt: this is the shared split
  rest=${hit#*:}
  HIT_LINE=${rest%%:*} # script-path-exempt: this is the shared split
  HIT_TEXT=${rest#*:}
}
