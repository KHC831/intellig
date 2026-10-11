/**
 * Every git process a test starts runs in the same environment, whatever the
 * machine's own git configuration:
 *  - one fixed identity: real-git tests commit (`git commit`, `git am`,
 *    `git stash`) in repositories they create, and a CI machine has no global
 *    identity ("Committer identity unknown");
 *  - no line-ending conversion: with `core.autocrlf=true`, as on a Windows
 *    runner, git checks files out with CRLF and a test reading back what it
 *    committed finds `theirs\r\n` where it wrote `theirs\n`.
 */

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'IntelliG Test',
  GIT_AUTHOR_EMAIL: 'test@intellig.test',
  GIT_COMMITTER_NAME: 'IntelliG Test',
  GIT_COMMITTER_EMAIL: 'test@intellig.test',
});

/** Add `key = value` to the config git reads from the environment (git 2.31+). */
function setGitConfig(key: string, value: string): void {
  const index = Number(process.env.GIT_CONFIG_COUNT ?? '0');
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
}

setGitConfig('core.autocrlf', 'false');
