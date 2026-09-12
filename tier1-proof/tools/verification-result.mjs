// Shared by the console and receipt so neither can contradict the stage results.
export function summarize(stages) {
  const held = stages.filter(s => s.status === 'held').length;
  const skipped = stages.filter(s => s.status === 'skip').length;
  const failed = stages.length - held - skipped;
  const complete = stages.length > 0 && failed === 0 && skipped === 0;
  const headline = failed
    ? `${failed} FAILED · ${held} held · ${skipped} skipped`
    : complete ? `all ${held} stages held`
      : `${held} held · ${skipped} SKIPPED — NOT A FULL VERIFICATION`;
  return { held, skipped, failed, complete, headline,
    exitCode: failed || stages.length === 0 ? 1 : 0 };
}

export function successfulProcess(result) {
  return result.status === 0 && !result.error && !result.signal;
}

export function sweepResult(result, expected = 10) {
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const ids = [...out.matchAll(/^\s*IS A FALSIFIER\s+S(\d+)\b/gm)].map(m => Number(m[1]));
  const complete = ids.length === expected && new Set(ids).size === expected
    && ids.every(id => id >= 1 && id <= expected);
  const bad = /NOT A FALSIFIER|RED, BUT NOT ON THE NAMED LAW|DOES NOT COMPILE/.test(out);
  return successfulProcess(result) && complete && !bad
    ? { status: 'held', result: `${ids.length}/${expected} falsifiers` }
    : { status: 'failed', why: `${ids.length}/${expected} falsifiers; exit ${result.status}; complete=${complete}; rejected=${bad}` };
}
