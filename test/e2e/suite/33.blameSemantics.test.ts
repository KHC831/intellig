/**
 * Tier-2 E2E — blame attribution semantics (real git).
 *
 * The blame-lab contract from the F5 matrix, pinned on real `git blame`
 * output through the live BlameService:
 *
 *   1. whitespace-only reformats do NOT steal blame by default (`-w` on),
 *   2. turning `ignoreWhitespace` off attributes the reindent author,
 *   3. `detectMovements: 'across'` traces a moved line to its original
 *      author in the source file (`-C`).
 *
 * History: Alice adds greet() → Bob adds bye() → Carol reindents (whitespace
 * only) → Dan moves greet() into greetings.py.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

async function commitAs(cwd: string, name: string, msg: string): Promise<void> {
  await execGit(cwd, ['add', '-A']);
  const email = `${name.toLowerCase()}@example.com`;
  // --author outranks the GIT_AUTHOR_* identity execGit pins; blame reports
  // the author, so this is the only per-commit knob the fixture needs.
  await execGit(cwd, ['commit', '-m', msg, '--author', `${name} <${email}>`]);
}

describe('e2e — blame whitespace and movement semantics', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let repo: IRepository;

  // greet() carries enough distinctive content to clear `git blame -C`'s
  // default copy-detection threshold (~40 alphanumeric chars per chunk) —
  // a two-line function is too small for -C to associate the move.
  const GREET = [
    'def greet(person_display_name, salutation_prefix="hello there"):',
    '    formatted_greeting_line = salutation_prefix + ", " + person_display_name + "!"',
    '    greeting_with_flourish = formatted_greeting_line + " welcome to the annotation lab"',
    '    return greeting_with_flourish',
  ];
  const BYE = ['def bye(person_display_name):', '    return "goodbye " + person_display_name'];
  const indent = (lines: string[]): string[] =>
    lines.map((l) => (l.startsWith('    ') ? '    ' + l : l));

  async function setup(): Promise<void> {
    fix = await createFixtureRepo({ commits: 1 });
    const cwd = fix.rootPath;
    const util = path.join(cwd, 'util.py');

    fs.writeFileSync(util, GREET.join('\n') + '\n');
    await commitAs(cwd, 'Alice', 'Add greet()');

    fs.writeFileSync(util, GREET.join('\n') + '\n\n' + BYE.join('\n') + '\n');
    await commitAs(cwd, 'Bob', 'Add bye()');

    // Whitespace-only reindent.
    fs.writeFileSync(util, indent(GREET).join('\n') + '\n\n' + indent(BYE).join('\n') + '\n');
    await commitAs(cwd, 'Carol', 'Reindent util.py (whitespace only)');

    // Move greet() to its own file.
    fs.writeFileSync(util, indent(BYE).join('\n') + '\n');
    fs.writeFileSync(path.join(cwd, 'greetings.py'), indent(GREET).join('\n') + '\n');
    await commitAs(cwd, 'Dan', 'Move greet() to greetings.py');

    repo = await useFixtureWorkspace(cwd);
  }

  afterEach(async () => {
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('whitespace-only reformats do not steal blame when ignoreWhitespace is on', async () => {
    await setup();
    const { blameService } = getServices()!;

    const info = await blameService.getBlame(repo, 'util.py', undefined, {
      ignoreWhitespace: true,
      detectMovements: 'none',
    });
    const authors = info.lines.map((l) => l.author);

    assert.ok(
      authors.includes('Bob'),
      `bye() must still be attributed to Bob, not the reindent; got ${JSON.stringify(authors)}`
    );
    assert.ok(
      !authors.includes('Carol'),
      `Carol's whitespace-only reindent must not own content lines; got ${JSON.stringify(authors)}`
    );
  });

  it('turning ignoreWhitespace off attributes the reindented lines to the reindent author', async () => {
    await setup();
    const { blameService } = getServices()!;

    const info = await blameService.getBlame(repo, 'util.py', undefined, {
      ignoreWhitespace: false,
      detectMovements: 'none',
    });
    const authors = info.lines.map((l) => l.author);

    assert.ok(
      authors.includes('Carol'),
      `with -w off the reindent must own the reindented lines; got ${JSON.stringify(authors)}`
    );
  });

  it("detectMovements 'across' traces a moved line back to its original author", async () => {
    await setup();
    const { blameService } = getServices()!;

    const moved = await blameService.getBlame(repo, 'greetings.py', undefined, {
      ignoreWhitespace: true,
      detectMovements: 'across',
    });
    const authors = moved.lines.map((l) => l.author);
    assert.ok(
      authors.includes('Alice'),
      `the moved greet() must trace to Alice with -C; got ${JSON.stringify(authors)}`
    );

    // Control: without movement detection the mover owns the whole file.
    const plain = await blameService.getBlame(repo, 'greetings.py', undefined, {
      ignoreWhitespace: true,
      detectMovements: 'none',
    });
    assert.ok(
      plain.lines.every((l) => l.author === 'Dan'),
      `without -C the mover owns every line; got ${JSON.stringify(plain.lines.map((l) => l.author))}`
    );
  });
});
