# ============================================================
# exempt-marker.sh — the shared per-line exemption-marker check.
# SOURCE this file; do not run it.
#
# Several structural guards let a line opt out of the class they fence with
# a `// <marker>: <reason>` comment, on the flagged line itself or the
# comment line directly above it (prettier moves a trailing comment off a
# multi-clause statement, so the above-line form is the stable placement).
# The exemption is per LINE, never per file: a marker parked at the top of a
# file must not silently un-fence everything below it. This check — and the
# window it reads — was copy-pasted verbatim into four guards before this
# extraction (rule 10: the Nth copy of a skeleton is the finding even while
# every copy is correct).
#
# Usage: is_exempt "$file" "$lineno" "$marker_text"
#   Returns 0 (true, exempt) if $marker_text appears anywhere on line
#   $lineno of $file, or on line $((lineno - 1)); 1 (false) otherwise.
is_exempt() {
  local file="$1" lineno="$2" marker="$3"
  local window
  window=$(sed -n "$(( lineno > 1 ? lineno - 1 : 1 )),${lineno}p" "$file")
  case "$window" in
    *"$marker"*) return 0 ;;
    *) return 1 ;;
  esac
}
