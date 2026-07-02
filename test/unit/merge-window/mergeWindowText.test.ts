import '../../setup';
import * as assert from 'assert';
import {
  detectEol,
  normalizeToLf,
  restoreEol,
} from '../../../src/conflicts/merge-window/mergeWindowText';

const LF = '\n' as const;
const CR = String.fromCharCode(13);
const CRLF = (CR + LF) as '\r\n';

describe('merge window text helpers', () => {
  it('detectEol prefers the majority separator', () => {
    assert.strictEqual(detectEol(''), LF);
    assert.strictEqual(detectEol('a'), LF);
    assert.strictEqual(detectEol(`a${LF}b${LF}c`), LF);
    assert.strictEqual(detectEol(`a${CRLF}b${CRLF}c`), CRLF);
    assert.strictEqual(detectEol(`a${CRLF}b${LF}c${CRLF}d`), CRLF);
    assert.strictEqual(detectEol(`a${CRLF}b${LF}c${LF}d`), LF);
  });

  it('normalizeToLf converts CRLF and lone CR', () => {
    assert.strictEqual(normalizeToLf(`a${CRLF}b${CR}c${LF}d`), `a${LF}b${LF}c${LF}d`);
    assert.strictEqual(normalizeToLf('abc'), 'abc');
  });

  it('restoreEol round-trips', () => {
    const original = `a${CRLF}b${CRLF}c`;
    const eol = detectEol(original);
    assert.strictEqual(restoreEol(normalizeToLf(original), eol), original);

    const lfText = `a${LF}b`;
    assert.strictEqual(restoreEol(lfText, LF), lfText);
    assert.strictEqual(restoreEol(lfText, CRLF), `a${CRLF}b`);
  });
});
