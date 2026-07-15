/**
 * Unit tests for aspect-column visibility + author name-format wiring in the
 * gutter and inline blame providers.
 *
 * Mirrors IntelliJ's per-aspect show/hide (`LineAnnotationAspect` AUTHOR / DATE
 * / REVISION, toggled by `AnnotateActionGroup`'s `ShowHideAspectAction`) and the
 * author "Names" submenu (`ShortNameType`). The providers read both off the
 * shared `BlameOptionsSource`, so these specs drive the format helpers that
 * assemble the annotation text.
 */

import * as assert from 'assert';
import { GutterBlameProvider } from '../../../src/blame/GutterBlameProvider';
import { InlineBlameProvider } from '../../../src/blame/InlineBlameProvider';
import { BlameOptionsSource } from '../../../src/blame/BlameOptionsSource';
import { IBlameService } from '../../../src/blame/interfaces/IBlameService';
import { IGitService, IBlameLine, IRepository } from '../../../src/git-core/interfaces/IGitService';
import * as vscode from '../../mocks/vscode';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';
import { noopEvent } from '../../mocks/noopEvent';

function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (store.get(key) as T) ?? defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
  };
}

const SAMPLE: IBlameLine = {
  line: 1,
  commit: 'abc1234def456789012345678901234567890abcd',
  author: 'John Smith',
  authorEmail: 'john@example.com',
  date: new Date('2024-01-15T12:00:00Z'),
  message: 'fix: a thing',
};

const stubBlame = {} as unknown as IBlameService;
const stubGit = {
  onDidChangeRepository: noopEvent<IRepository>(),
} as unknown as IGitService;

type GutterSeam = { formatGutterText(bl: IBlameLine): string };
type InlineSeam = { formatInlineText(bl: IBlameLine): string };

describe('blame aspect columns + name format', () => {
  let source: BlameOptionsSource;
  let gutter: GutterBlameProvider;
  let inline: InlineBlameProvider;

  beforeEach(() => {
    resetMockConfiguration();
    source = new BlameOptionsSource(makeMemento());
    gutter = new GutterBlameProvider(stubBlame, stubGit, source);
    inline = new InlineBlameProvider(stubBlame, stubGit, source);
  });

  afterEach(() => {
    gutter.dispose();
    inline.dispose();
    source.dispose();
  });

  describe('gutter', () => {
    function text(): string {
      return (gutter as unknown as GutterSeam).formatGutterText(SAMPLE);
    }

    it('shows author, date, and the short hash by default', () => {
      const out = text();
      assert.ok(out.includes('John Smith'), `author shown; got: ${out}`);
      assert.ok(out.includes('abc1234'), `short hash shown; got: ${out}`);
    });

    it('omits the author column when the author aspect is hidden', () => {
      setMockConfigValue('intellig', 'blame.showAuthor', false);
      const out = text();
      assert.ok(!out.includes('Smith'), `author omitted; got: ${out}`);
      assert.ok(out.includes('abc1234'), `hash still shown; got: ${out}`);
    });

    it('omits the short hash when the revision aspect is hidden', () => {
      setMockConfigValue('intellig', 'blame.showRevision', false);
      const out = text();
      assert.ok(!out.includes('abc1234'), `hash omitted; got: ${out}`);
      assert.ok(out.includes('John Smith'), `author still shown; got: ${out}`);
    });

    it('renders the author per the selected name format', () => {
      setMockConfigValue('intellig', 'blame.authorNameFormat', 'lastname');
      const out = text();
      assert.ok(out.includes('Smith'), `last name shown; got: ${out}`);
      assert.ok(!out.includes('John Smith'), `full name suppressed; got: ${out}`);
    });
  });

  describe('inline', () => {
    function text(): string {
      return (inline as unknown as InlineSeam).formatInlineText(SAMPLE);
    }

    it('shows author and message by default', () => {
      const out = text();
      assert.ok(out.includes('John Smith'), `author shown; got: ${out}`);
      assert.ok(out.includes('fix: a thing'), `message shown; got: ${out}`);
    });

    it('omits the author when the author aspect is hidden', () => {
      setMockConfigValue('intellig', 'blame.showAuthor', false);
      const out = text();
      assert.ok(!out.includes('Smith'), `author omitted; got: ${out}`);
      assert.ok(out.includes('fix: a thing'), `message still shown; got: ${out}`);
    });

    it('prepends the short hash when the revision aspect is shown', () => {
      setMockConfigValue('intellig', 'blame.showRevision', true);
      const out = text();
      assert.ok(out.includes('abc1234'), `short hash shown; got: ${out}`);
    });

    it('renders the author per the selected name format', () => {
      setMockConfigValue('intellig', 'blame.authorNameFormat', 'initials');
      const out = text();
      assert.ok(out.includes('JS'), `initials shown; got: ${out}`);
    });
  });
});
