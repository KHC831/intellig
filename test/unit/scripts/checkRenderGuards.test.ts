/**
 * Companion spec for `scripts/check-render-guards.mjs`.
 *
 * Every probe here is a DELIBERATELY BROKEN input. A guard is only worth its
 * green run if someone has watched it go red for each thing it claims to catch,
 * and on this project two separate fences have been caught reporting OK while
 * scanning nothing. So these assert the script's OUTPUT and EXIT CODE against
 * fixtures built to defeat it, not that it passes on the real tree.
 *
 * Fixtures are written under `workspace-notes/tmp/` per the repo's scratch rule.
 */

import '../../setup';
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-render-guards.mjs');
const SCRATCH = path.join(REPO_ROOT, 'workspace-notes/tmp');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the fence over `file`, treating `keys` as the idempotence table. */
function runFence(file: string, keys: string[] = []): Run {
  try {
    const stdout = execFileSync('node', [SCRIPT, file, keys.join(',')], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

let dir: string;

function fixture(name: string, body: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

describe('check-render-guards', () => {
  before(() => {
    mkdirSync(SCRATCH, { recursive: true });
    dir = mkdtempSync(path.join(SCRATCH, 'render-guards-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('fails closed rather than silently scanning nothing', () => {
    it('exits non-zero when the scan target does not exist', () => {
      const run = runFence(path.join(dir, 'no-such-file.ts'));

      assert.strictEqual(run.status, 1, 'a missing target must not read as a pass');
      assert.match(run.stderr, /does not exist — nothing scanned/);
    });

    it('exits non-zero when the file exists but holds no class', () => {
      const file = fixture('noclass.ts', 'export const x = 1;\n');

      const run = runFence(file);

      assert.strictEqual(run.status, 1, 'nothing to scan is not the same as nothing wrong');
      assert.match(run.stderr, /no class declaration found/);
    });

    it('exits non-zero when a class exists but yields no render sites', () => {
      const file = fixture(
        'norenders.ts',
        ['export class C {', '  doThing(): void {', '    this._other();', '  }', '}', ''].join('\n')
      );

      const run = runFence(file);

      assert.strictEqual(run.status, 1, 'a rotted regex reports zero sites, which is not OK');
      assert.match(run.stderr, /no render sites found/);
    });
  });

  describe('maps a render to the method that really contains it', () => {
    // The mapping bug this pins is not hypothetical: anchoring the header on a
    // closing paren or body brace mis-attributes every multi-line signature,
    // and the provider has three. `updateLogState` is the setter the whole
    // effort is built around, and it would drop out of the inventory entirely.
    const MULTILINE = [
      'export class C {',
      '  setNoRepository(): void {',
      '    this._flag = true;',
      '  }',
      '',
      '  updateLogState(',
      '    commits: string[],',
      '    branchMap?: Map<string, string>',
      '  ): void {',
      '    this._render();',
      '  }',
      '}',
      '',
    ].join('\n');

    it('names the method whose parameters span lines, not the one before it', () => {
      const file = fixture('multiline.ts', MULTILINE);

      const run = runFence(file, []);

      assert.match(
        run.stderr,
        /updateLogState — public and renders/,
        'the render belongs to updateLogState'
      );
      assert.doesNotMatch(
        run.stderr,
        /setNoRepository/,
        'setNoRepository contains no render and must not be blamed for one'
      );
    });

    it('names a method whose parameter is an inline object type', () => {
      const file = fixture(
        'inlineobj.ts',
        [
          'export class C {',
          '  addConsoleEntry(): void {',
          '    this._noop();',
          '  }',
          '',
          '  updateConsoleEntry(update: {',
          '    id: string;',
          '  }): void {',
          '    this._render();',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, []);

      assert.match(run.stderr, /updateConsoleEntry — public and renders/);
      assert.doesNotMatch(run.stderr, /addConsoleEntry/);
    });

    it('treats a member with no access modifier as public', () => {
      const file = fixture(
        'nomodifier.ts',
        [
          'export class C {',
          '  updateWebview(): void {',
          '    this._render();',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, []);

      assert.strictEqual(run.status, 1, 'most of this class is public without saying so');
      assert.match(run.stderr, /updateWebview — public and renders/);
    });

    it('leaves private and protected members alone', () => {
      const file = fixture(
        'private.ts',
        [
          'export class C {',
          '  private _paint(): void {',
          '    this._render();',
          '  }',
          '',
          '  protected _onResolve(',
          '    ctx: string',
          '  ): void {',
          '    this._render();',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, []);

      assert.strictEqual(run.status, 0, 'non-public members are out of scope');
      assert.match(run.stdout, /owners=0/);
    });

    it('excludes the constructor, which cannot be called twice on one instance', () => {
      const file = fixture(
        'ctor.ts',
        [
          'export class C {',
          '  constructor(uri: string) {',
          '    this._renderForGesture();',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, []);

      assert.strictEqual(run.status, 0, 'an idempotence claim about a constructor is meaningless');
      assert.match(run.stdout, /owners=0/);
    });
  });

  describe('sees every entry point that ends in a document rebuild', () => {
    // The hole most likely to actually occur: extracted handlers repaint via
    // `updateWebview`, so a fence anchored on `_render` alone would wave them
    // through. One case per entry point, because a set is only as good as its
    // least-tested member.
    for (const funnel of [
      '_render',
      '_renderForGesture',
      '_renderOnResolve',
      '_renderSidebarPlaceholder',
      'updateWebview',
    ]) {
      it(`flags a setter that repaints through ${funnel}`, () => {
        const file = fixture(
          `funnel-${funnel}.ts`,
          [
            'export class C {',
            '  setThing(v: string): void {',
            `    this.${funnel}();`,
            '  }',
            '}',
            '',
          ].join('\n')
        );

        const run = runFence(file, []);

        assert.strictEqual(run.status, 1, `${funnel} rebuilds the document and must be seen`);
        assert.match(run.stdout, /sites=1/);
      });
    }
  });

  describe('reads code as code and comments as comments', () => {
    it('does not count a render written inside a comment or a template literal', () => {
      const file = fixture(
        'quoted.ts',
        [
          'export class C {',
          '  setThing(): void {',
          '    // this._render();',
          '    const css = `a { color: red } this._render();`;',
          '    this._render();',
          '    void css;',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, []);

      assert.match(run.stdout, /sites=1/, 'only the real call composes anything');
    });

    it('does not accept the annotation spelled inside a string literal', () => {
      const file = fixture(
        'hatch-in-string.ts',
        [
          'export class C {',
          '  setThing(): void {',
          "    const s = 'render-unconditional: not a claim, just text';",
          '    this._render();',
          '    void s;',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, []);

      assert.strictEqual(run.status, 1, 'a hatch is a claim, and a claim has to be a comment');
      assert.match(run.stdout, /annotated=0/);
    });

    it('accepts the same annotation as a real comment', () => {
      const file = fixture(
        'hatch-in-comment.ts',
        [
          'export class C {',
          '  setThing(): void {',
          '    // render-unconditional: appends, so a repeat is a different state',
          '    this._render();',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, []);

      assert.strictEqual(run.status, 0);
      assert.match(run.stdout, /annotated=1/);
    });
  });

  describe('will not let a nested render hide behind its method', () => {
    // Three callback spellings, checked side by side. The arrow is the control;
    // the method shorthand and the accessor are the shapes that carry neither
    // `=>` nor `function`, and a render inside one of those was credited to the
    // enclosing method's idempotence entry — a pre-blessed render in the one
    // shape the detector could not see. Each case passes the method IN as a
    // covered key, so being listed must not be enough.
    const CALLBACK_SPELLINGS: Array<[string, string[]]> = [
      [
        'an arrow',
        ['    this._sub = svc.onState((): void => {', '      this._render();', '    });'],
      ],
      [
        'object-literal method shorthand',
        [
          '    this._sub = svc.on({',
          '      onChange(): void {',
          '        this._render();',
          '      },',
          '    });',
        ],
      ],
      [
        'a get accessor',
        [
          '    this._sub = svc.on({',
          '      get value(): number {',
          '        this._render();',
          '        return 1;',
          '      },',
          '    });',
        ],
      ],
      [
        'a set accessor',
        [
          '    this._sub = svc.on({',
          '      set value(v: number) {',
          '        this._render();',
          '      },',
          '    });',
        ],
      ],
    ];

    for (const [label, inner] of CALLBACK_SPELLINGS) {
      it(`demands an annotation for a render inside ${label}, even when the method is listed`, () => {
        const file = fixture(
          `nested-${label.replace(/\W+/g, '-')}.ts`,
          [
            'export class C {',
            '  attachGitService(svc: any): void {',
            ...inner,
            '  }',
            '}',
            '',
          ].join('\n')
        );

        const run = runFence(file, ['attachGitService']);

        assert.strictEqual(run.status, 1, 'an idempotence entry cannot reach a callback render');
        assert.match(run.stderr, /render sits in a nested callback/);
      });
    }

    it('still credits a listed method for a render in its own body, not in a callback', () => {
      // The other direction: over-reach here would force annotations onto
      // methods that genuinely do guard, which inflates the count the header
      // promises will only fall.
      const file = fixture(
        'not-nested.ts',
        [
          'export class C {',
          '  setThing(v: string): void {',
          '    if (v !== this._v) {',
          '      this._render();',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, ['setThing']);

      assert.strictEqual(run.status, 0, 'an if-block introduces no call boundary');
      assert.match(run.stdout, /covered=1/);
    });
  });

  describe('couples the coverage claim to the spec that exercises it', () => {
    it('accepts a method that is a key of the idempotence table', () => {
      const file = fixture(
        'covered.ts',
        [
          'export class C {',
          '  setHasRepository(v: boolean): void {',
          '    if (v !== this._has) {',
          '      this._render();',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, ['setHasRepository']);

      assert.strictEqual(run.status, 0);
      assert.match(run.stdout, /covered=1/);
    });

    it('rejects the same method when it is not a key', () => {
      const file = fixture(
        'uncovered.ts',
        [
          'export class C {',
          '  setHasRepository(v: boolean): void {',
          '    this._render();',
          '  }',
          '}',
          '',
        ].join('\n')
      );

      const run = runFence(file, ['somethingElse']);

      assert.strictEqual(run.status, 1);
      assert.match(run.stderr, /neither a key of RENDER_IDEMPOTENCE_CASES nor annotated/);
    });
  });

  describe('the real tree', () => {
    it('holds its stated starting line: 10 owners, 5 covered, 5 annotated', () => {
      // The annotation count may only ever DECREASE. If this fails because the
      // count went up, that is the review event the header describes, not a
      // number to bump. If it fails because the count went down, retire the
      // annotation and lower it here in the same commit.
      const run = runFence(
        path.join(REPO_ROOT, 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        [
          'setHasRepository',
          'updateLogState',
          'setCherryPickedHashes',
          'setAvailableRepositories',
          'clearConsole',
        ]
      );

      assert.strictEqual(run.status, 0, run.stderr);
      assert.match(run.stdout, /owners=10 covered=5 annotated=5/);
    });
  });
});
