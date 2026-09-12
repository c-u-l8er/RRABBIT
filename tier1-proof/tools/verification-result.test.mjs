import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, successfulProcess, sweepResult } from './verification-result.mjs';

for (const [name, statuses, exit, complete] of [
  ['all passed', ['held', 'held'], 0, true],
  ['failed only', ['held', 'failed'], 1, false],
  ['skipped only', ['held', 'skip'], 0, false],
  ['failed and skipped', ['failed', 'skip'], 1, false],
  ['nothing ran', [], 1, false],
  ['unknown outcome', ['held', 'unexpected'], 1, false],
]) {
  test(name, () => {
    const result = summarize(statuses.map(status => ({ status })));
    assert.equal(result.exitCode, exit);
    assert.equal(result.complete, complete);
    assert.equal(/all .* stages held/.test(result.headline), complete);
    if (statuses.includes('failed')) assert.match(result.headline, /FAILED/);
    if (statuses.includes('skip')) assert.match(result.headline, /SKIPPED|skipped/);
  });
}

test('a success-looking message never overrides process failure or timeout', () => {
  for (const r of [{ status: 1 }, { status: null, signal: 'SIGTERM' },
    { status: 0, error: new Error('spawn failed') }]) {
    assert.equal(successfulProcess(r), false);
  }
  assert.equal(successfulProcess({ status: 0 }), true);
});

const sweep = (ids, extra = {}) => ({ status: 0,
  stdout: ids.map(id => `  IS A FALSIFIER    S${id} named law`).join('\n'), ...extra });
test('the sweep requires every distinct sabotage and successful restoration', () => {
  const all = Array.from({ length: 10 }, (_, i) => i + 1);
  assert.equal(sweepResult(sweep(all)).status, 'held');
  for (const r of [sweep(all.slice(0, 9)), sweep([...all.slice(0, 9), 9]),
    sweep(all, { status: 1 }), sweep(all, { signal: 'SIGTERM', status: null }),
    sweep(all, { stderr: 'DOES NOT COMPILE S4' })]) {
    assert.equal(sweepResult(r).status, 'failed');
  }
});
