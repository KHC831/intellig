/**
 * Unit tests for the Update Project structured-notification builder.
 * Preserves the buildUpdateNotification coverage from the deleted
 * NotificationService suite.
 */
import '../../setup';
import * as assert from 'assert';
import { buildUpdateNotification } from '../../../src/ui-shell/updateNotification';

describe('buildUpdateNotification', () => {
  it('info severity + a Show Update Info deep-link when all clean', () => {
    const n = buildUpdateNotification(true, 'Updated 1 repository; 3 commit(s) pulled.');
    assert.strictEqual(n.severity, 'info');
    assert.strictEqual(n.message, 'Updated 1 repository; 3 commit(s) pulled.');
    assert.deepStrictEqual(n.deepLinks?.[0], {
      label: 'Show Update Info',
      commandId: 'intellig.toolWindow.focusTab',
      commandArgs: ['updateInfo'],
    });
  });

  it('warning severity when not all clean', () => {
    const n = buildUpdateNotification(false, 'Update finished with 1 conflict(s).');
    assert.strictEqual(n.severity, 'warning');
    assert.strictEqual(n.message, 'Update finished with 1 conflict(s).');
    assert.strictEqual(n.deepLinks?.[0].commandId, 'intellig.toolWindow.focusTab');
  });
});
