import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Extension Test Suite', () => {
  void vscode.window.showInformationMessage('Start all tests.');

  it('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('KaHoChan.intellig'));
  });

  it('Extension should activate', async () => {
    const extension = vscode.extensions.getExtension('KaHoChan.intellig');
    if (extension) {
      await extension.activate();
      assert.strictEqual(extension.isActive, true);
    }
  });
});
