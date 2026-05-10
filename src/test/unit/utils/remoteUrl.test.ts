/**
 * Unit tests for T3-09 remote-URL parser + hosting-link builders.
 */

import '../../../test/setup';
import * as assert from 'assert';
import { parseRemoteUrl, detectProvider, IRemoteUrl } from '../../../utils/remoteUrl';
import {
  commitUrl,
  issueUrl,
  repoUrl,
  hostingProviderLabel,
  findIssueReferences,
  ISSUE_REFERENCE_REGEX,
} from '../../../utils/hostingLinks';

describe('T3-09 — parseRemoteUrl', () => {
  const cases: Array<{
    label: string;
    url: string;
    expect: Pick<IRemoteUrl, 'host' | 'owner' | 'repo' | 'provider' | 'pathPrefix'>;
  }> = [
    {
      label: 'github HTTPS with .git',
      url: 'https://github.com/acme/widgets.git',
      expect: {
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        provider: 'github',
        pathPrefix: 'acme',
      },
    },
    {
      label: 'github HTTPS without .git',
      url: 'https://github.com/acme/widgets',
      expect: {
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        provider: 'github',
        pathPrefix: 'acme',
      },
    },
    {
      label: 'github SSH',
      url: 'git@github.com:acme/widgets.git',
      expect: {
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        provider: 'github',
        pathPrefix: 'acme',
      },
    },
    {
      label: 'gitlab HTTPS with nested group',
      url: 'https://gitlab.com/team/frontend/ui-kit.git',
      expect: {
        host: 'gitlab.com',
        owner: 'team',
        repo: 'ui-kit',
        provider: 'gitlab',
        pathPrefix: 'team/frontend',
      },
    },
    {
      label: 'self-hosted GitLab',
      url: 'https://gitlab.example.com/group/project.git',
      expect: {
        host: 'gitlab.example.com',
        owner: 'group',
        repo: 'project',
        provider: 'gitlab',
        pathPrefix: 'group',
      },
    },
    {
      label: 'bitbucket HTTPS',
      url: 'https://bitbucket.org/acme/widgets.git',
      expect: {
        host: 'bitbucket.org',
        owner: 'acme',
        repo: 'widgets',
        provider: 'bitbucket',
        pathPrefix: 'acme',
      },
    },
    {
      label: 'bitbucket SSH',
      url: 'git@bitbucket.org:acme/widgets.git',
      expect: {
        host: 'bitbucket.org',
        owner: 'acme',
        repo: 'widgets',
        provider: 'bitbucket',
        pathPrefix: 'acme',
      },
    },
    {
      label: 'ssh://-prefixed URL',
      url: 'ssh://git@github.com/acme/widgets.git',
      expect: {
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        provider: 'github',
        pathPrefix: 'acme',
      },
    },
    {
      label: 'bare host/owner/repo',
      url: 'github.com/acme/widgets',
      expect: {
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
        provider: 'github',
        pathPrefix: 'acme',
      },
    },
    {
      label: 'unknown self-hosted',
      url: 'https://code.internal.example/team/project.git',
      expect: {
        host: 'code.internal.example',
        owner: 'team',
        repo: 'project',
        provider: 'unknown',
        pathPrefix: 'team',
      },
    },
  ];

  for (const tc of cases) {
    it(tc.label, () => {
      const parsed = parseRemoteUrl(tc.url);
      assert.ok(parsed, `expected parseRemoteUrl to return a value for "${tc.url}"`);
      assert.deepStrictEqual(
        {
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          provider: parsed.provider,
          pathPrefix: parsed.pathPrefix,
        },
        tc.expect
      );
    });
  }

  it('returns undefined for empty / null input', () => {
    assert.strictEqual(parseRemoteUrl(''), undefined);
    assert.strictEqual(parseRemoteUrl(undefined), undefined);
    assert.strictEqual(parseRemoteUrl(null), undefined);
  });

  it('returns undefined for URLs with no repo segment (e.g., user home page)', () => {
    assert.strictEqual(parseRemoteUrl('https://github.com/acme'), undefined);
    assert.strictEqual(parseRemoteUrl('github.com/acme'), undefined);
  });

  it('returns undefined for garbage input', () => {
    assert.strictEqual(parseRemoteUrl('not a url'), undefined);
    assert.strictEqual(parseRemoteUrl('   '), undefined);
  });

  it('trims surrounding whitespace', () => {
    const parsed = parseRemoteUrl('  https://github.com/acme/widgets.git  ');
    assert.ok(parsed);
    assert.strictEqual(parsed.owner, 'acme');
    assert.strictEqual(parsed.repo, 'widgets');
  });

  it('lowercases the host', () => {
    const parsed = parseRemoteUrl('git@GITHUB.COM:acme/widgets.git');
    assert.ok(parsed);
    assert.strictEqual(parsed.host, 'github.com');
  });
});

describe('T3-09 — detectProvider', () => {
  const rows: Array<[string, 'github' | 'gitlab' | 'bitbucket' | 'unknown']> = [
    ['github.com', 'github'],
    ['enterprise.github.com', 'github'],
    ['gitlab.com', 'gitlab'],
    ['gitlab.example.org', 'gitlab'],
    ['repos.gitlab.com', 'gitlab'],
    ['bitbucket.org', 'bitbucket'],
    ['code.internal.example', 'unknown'],
    ['example.com', 'unknown'],
  ];
  for (const [host, provider] of rows) {
    it(`${host} → ${provider}`, () => {
      assert.strictEqual(detectProvider(host), provider);
    });
  }
});

describe('T3-09 — URL builders', () => {
  const github: IRemoteUrl = {
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets',
    provider: 'github',
    pathPrefix: 'acme',
  };
  const gitlab: IRemoteUrl = {
    host: 'gitlab.com',
    owner: 'team',
    repo: 'ui-kit',
    provider: 'gitlab',
    pathPrefix: 'team/frontend',
  };
  const bitbucket: IRemoteUrl = {
    host: 'bitbucket.org',
    owner: 'acme',
    repo: 'widgets',
    provider: 'bitbucket',
    pathPrefix: 'acme',
  };
  const unknown: IRemoteUrl = {
    host: 'x.example.com',
    owner: 'team',
    repo: 'project',
    provider: 'unknown',
    pathPrefix: 'team',
  };

  it('repoUrl composes https://<host>/<path>/<repo>', () => {
    assert.strictEqual(repoUrl(github), 'https://github.com/acme/widgets');
    assert.strictEqual(repoUrl(gitlab), 'https://gitlab.com/team/frontend/ui-kit');
    assert.strictEqual(repoUrl(bitbucket), 'https://bitbucket.org/acme/widgets');
  });

  it("commitUrl honours each provider's URL shape", () => {
    const hash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80123';
    assert.strictEqual(commitUrl(github, hash), `https://github.com/acme/widgets/commit/${hash}`);
    assert.strictEqual(
      commitUrl(gitlab, hash),
      `https://gitlab.com/team/frontend/ui-kit/-/commit/${hash}`
    );
    assert.strictEqual(
      commitUrl(bitbucket, hash),
      `https://bitbucket.org/acme/widgets/commits/${hash}`
    );
    assert.strictEqual(commitUrl(unknown, hash), undefined);
  });

  it('commitUrl rejects malformed hashes', () => {
    assert.strictEqual(commitUrl(github, ''), undefined);
    assert.strictEqual(commitUrl(github, 'not-hex'), undefined);
    assert.strictEqual(commitUrl(github, 'abc'), undefined, 'too short');
  });

  it('issueUrl dispatches on provider', () => {
    assert.strictEqual(issueUrl(github, 42), 'https://github.com/acme/widgets/issues/42');
    assert.strictEqual(issueUrl(gitlab, 42), 'https://gitlab.com/team/frontend/ui-kit/-/issues/42');
    assert.strictEqual(issueUrl(bitbucket, 42), 'https://bitbucket.org/acme/widgets/issues/42');
    assert.strictEqual(issueUrl(unknown, 42), undefined);
  });

  it('issueUrl handles string ids with stripping', () => {
    assert.strictEqual(issueUrl(github, '42'), 'https://github.com/acme/widgets/issues/42');
    assert.strictEqual(issueUrl(github, '  42  '), 'https://github.com/acme/widgets/issues/42');
    assert.strictEqual(issueUrl(github, '0'), undefined, 'zero-id rejected');
    assert.strictEqual(issueUrl(github, '-1'), undefined, 'negative rejected');
    assert.strictEqual(issueUrl(github, 'abc'), undefined, 'non-numeric rejected');
  });

  it('hostingProviderLabel returns a user-facing string per provider', () => {
    assert.strictEqual(hostingProviderLabel(github), 'Open on GitHub');
    assert.strictEqual(hostingProviderLabel(gitlab), 'Open on GitLab');
    assert.strictEqual(hostingProviderLabel(bitbucket), 'Open on Bitbucket');
    assert.strictEqual(hostingProviderLabel(unknown), undefined);
  });
});

describe('T3-09 — findIssueReferences', () => {
  it('finds a simple #N reference', () => {
    const refs = findIssueReferences('fix: crash on startup (#42)');
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].id, '42');
    assert.strictEqual(refs[0].kind, 'hash');
    assert.strictEqual(refs[0].raw, '#42');
  });

  it('finds GH-N references', () => {
    const refs = findIssueReferences('addresses GH-101 and GH-77');
    assert.strictEqual(refs.length, 2);
    assert.strictEqual(refs[0].kind, 'gh-number');
    assert.strictEqual(refs[0].id, '101');
    assert.strictEqual(refs[1].id, '77');
  });

  it('finds JIRA-style PROJ-N references', () => {
    const refs = findIssueReferences('PROJ-5: initial commit; see also INT-12');
    assert.strictEqual(refs.length, 2);
    assert.strictEqual(refs[0].kind, 'jira');
    assert.strictEqual(refs[0].raw, 'PROJ-5');
    assert.strictEqual(refs[1].raw, 'INT-12');
  });

  it('returns start/end positions usable for span-wrapping', () => {
    const msg = 'fix: see #9';
    const [ref] = findIssueReferences(msg);
    assert.strictEqual(msg.slice(ref.start, ref.end), '#9');
  });

  it('does not match non-word boundaries', () => {
    // `abc#42` is not a reference.
    const refs = findIssueReferences('abc#42 PROJ-5x');
    assert.strictEqual(refs.length, 0);
  });

  it('handles empty / undefined input', () => {
    assert.deepStrictEqual(findIssueReferences(''), []);
    // @ts-expect-error — exercising runtime guard
    assert.deepStrictEqual(findIssueReferences(undefined), []);
  });

  it('is safe to call repeatedly (lastIndex reset)', () => {
    const msg = 'PROJ-1 and PROJ-2';
    const first = findIssueReferences(msg);
    const second = findIssueReferences(msg);
    assert.strictEqual(first.length, 2);
    assert.strictEqual(second.length, 2);
  });

  it('ISSUE_REFERENCE_REGEX is exported and global-flagged', () => {
    assert.ok(ISSUE_REFERENCE_REGEX.global, 'should be global');
    // Matches bare prefix + digits combo.
    assert.ok(new RegExp(ISSUE_REFERENCE_REGEX.source).test('GH-1'));
  });
});
