/**
 * Define Remote dialog webview-entry specs.
 *
 * IntelliJ's GitDefineRemoteDialog (git4idea backend/src/remote) collects name
 * and URL in ONE form with always-visible validation, an explicit OK, and it
 * stays open when `git ls-remote` says the URL is unreachable. These specs pin
 * that contract on our port: validation surfaces in the dialog, OK is gated on
 * validity, and a host-reported failure leaves the dialog usable.
 *
 * Files exercised: sync/webview/defineRemoteDialog.ts.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { initIslandHtml } from '../../../src/utils/webviewInit';
import type { IDefineRemoteDialogInit } from '../../../src/sync/defineRemoteDialog.protocol';

function boot(overrides: Partial<IDefineRemoteDialogInit> = {}): IWebviewEntryHarness {
  const init: IDefineRemoteDialogInit = {
    name: '',
    url: '',
    existingNames: ['origin'],
    originalName: null,
    fetch: true,
    submitLabel: 'Add',
    ...overrides,
  };
  return bootWebviewEntry('sync/webview/defineRemoteDialog', {
    bodyHtml: `<div id="root"></div>${initIslandHtml(init)}`,
  });
}

function input(h: IWebviewEntryHarness, id: string): HTMLInputElement {
  return h.document.getElementById(id) as unknown as HTMLInputElement;
}

function submitBtn(h: IWebviewEntryHarness): HTMLButtonElement {
  return h.document.getElementById('submit-btn') as unknown as HTMLButtonElement;
}

/** Type into a field the way a user does: set value, fire `input`. */
function type(h: IWebviewEntryHarness, id: string, value: string): void {
  const field = input(h, id);
  field.value = value;
  field.dispatchEvent(new h.window.Event('input', { bubbles: true }));
}

function errorText(h: IWebviewEntryHarness): string {
  return h.document.getElementById('form-error')?.textContent ?? '';
}

describe('webview: define remote dialog', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('builds both fields, the fetch option, and the action buttons in one form', () => {
    h = boot({ name: 'origin', url: 'https://example.com/o.git', originalName: 'origin' });

    assert.deepStrictEqual(
      {
        name: input(h, 'remote-name').value,
        url: input(h, 'remote-url').value,
        fetch: input(h, 'fetch-after').checked,
        submit: submitBtn(h).textContent,
        cancel: Boolean(h.document.getElementById('cancel-btn')),
      },
      {
        name: 'origin',
        url: 'https://example.com/o.git',
        fetch: true,
        submit: 'Add',
        cancel: true,
      }
    );
  });

  it('names the duplicate remote in a visible message instead of silently refusing', () => {
    h = boot();

    type(h, 'remote-name', 'origin');

    assert.match(
      h.document.getElementById('remote-name-error')?.textContent ?? '',
      /already exists/
    );
  });

  it('disables the submit button while the name is a duplicate', () => {
    h = boot({ url: 'https://example.com/o.git' });

    type(h, 'remote-name', 'origin');

    assert.strictEqual(submitBtn(h).disabled, true);
  });

  it('accepts the edited remote keeping its own name', () => {
    h = boot({ name: 'origin', url: 'https://example.com/o.git', originalName: 'origin' });

    assert.strictEqual(submitBtn(h).disabled, false);
  });

  it('disables the submit button until the URL is filled in', () => {
    h = boot();

    type(h, 'remote-name', 'upstream');

    assert.strictEqual(submitBtn(h).disabled, true);
    assert.match(h.document.getElementById('remote-url-error')?.textContent ?? '', /empty/i);
  });

  it('posts the trimmed name, URL, and fetch choice on submit', () => {
    h = boot();
    type(h, 'remote-name', '  upstream  ');
    type(h, 'remote-url', '  https://example.com/u.git  ');
    input(h, 'fetch-after').checked = false;

    submitBtn(h).click();

    assert.deepStrictEqual(h.posted.at(-1), {
      type: 'submit',
      name: 'upstream',
      url: 'https://example.com/u.git',
      fetch: false,
    });
  });

  it('does not post a submit while the form is invalid', () => {
    h = boot();
    type(h, 'remote-name', 'origin');

    submitBtn(h).click();

    assert.deepStrictEqual(h.posted, []);
  });

  it('shows the host error and re-enables submit so an unreachable URL can be corrected', () => {
    h = boot();
    type(h, 'remote-name', 'upstream');
    type(h, 'remote-url', 'https://bad.example/u.git');
    submitBtn(h).click();

    h.post({ type: 'busy', busy: true });
    h.post({ type: 'error', message: 'could not read from remote repository' });

    assert.match(errorText(h), /could not read from remote repository/);
    assert.strictEqual(submitBtn(h).disabled, false, 'the dialog stays usable');
  });

  it('disables submit while the reachability probe runs', () => {
    h = boot();
    type(h, 'remote-name', 'upstream');
    type(h, 'remote-url', 'https://example.com/u.git');

    h.post({ type: 'busy', busy: true });

    assert.strictEqual(submitBtn(h).disabled, true);
  });

  it('posts cancel when the cancel button is clicked', () => {
    h = boot();

    h.document.getElementById('cancel-btn')?.click();

    assert.deepStrictEqual(h.posted.at(-1), { type: 'cancel' });
  });

  it('tolerates garbage host messages without throwing', () => {
    h = boot();

    for (const msg of [{ type: 'nope' }, { type: undefined }, {}, null]) {
      h.post(msg);
    }

    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });
});
