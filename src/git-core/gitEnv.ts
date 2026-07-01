/**
 * Environment overrides that force git's commit-producing continue/complete
 * steps to run non-interactively.
 *
 * `git rebase|cherry-pick|revert|merge --continue` (and the sequencer) open
 * `$EDITOR`/`$GIT_SEQUENCE_EDITOR` to confirm the replayed commit's message.
 * Under VS Code's non-TTY child-process spawn there is no editor, so those
 * steps fail with "Terminal is dumb, but EDITOR unset" and the operation
 * dead-ends. `GIT_EDITOR=true` (which overrides even a `core.editor=''`)
 * commits the prepared message verbatim; `GIT_SEQUENCE_EDITOR=true` covers the
 * rebase/sequencer todo step and is harmless where unused (only rebase/cherry
 * sequencer editing consults it). Applying both at every continue/complete site
 * from one const keeps the pin from drifting — a new site that forgets it would
 * reintroduce the "Terminal is dumb" regression.
 *
 * Callers merge this OVER the ambient env (`{ ...process.env, ...THIS }`, or via
 * `gitCli.exec`, which spreads `process.env` itself) so PATH/HOME survive.
 */
export const NON_INTERACTIVE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
};
