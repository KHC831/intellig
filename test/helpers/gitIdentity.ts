/**
 * Every git process a test starts commits as one fixed identity. Real-git
 * tests create repositories and commit in them (`git commit`, `git am`,
 * `git stash`); a developer machine has a global identity, a CI machine does
 * not, and a test that passed on the first failed on the second with
 * "Committer identity unknown".
 */

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'IntelliG Test',
  GIT_AUTHOR_EMAIL: 'test@intellig.test',
  GIT_COMMITTER_NAME: 'IntelliG Test',
  GIT_COMMITTER_EMAIL: 'test@intellig.test',
});
