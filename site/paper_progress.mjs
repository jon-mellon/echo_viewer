export const REVIEW_STAGES = [
  ['qualify', 'Check claim'], ['load', 'Load evidence'], ['setup', 'Match variables'],
  ['map', 'Find confounders'], ['assess', 'Assess confounders'],
  ['findings', 'Check supporting findings'], ['validate', 'Validate review']
];
export function recordProgress(run, stage, title, detail = '', now = Date.now()) {
  const previous = run.progress;
  const at = new Date(now).toISOString();
  const changed = previous?.stage !== stage || previous?.detail !== detail || previous?.title !== title;
  run.progress = { stage, title, detail, updatedAt: at,
    stageStartedAt: previous?.stage === stage ? previous.stageStartedAt : at,
    history: [...(previous?.history || []), ...(changed ? [{ stage, title, detail, at }] : [])].slice(-12) };
  return run.progress;
}
export function reportProgress(model, stage, title, detail = '') {
  const value = recordProgress(model.run, stage, title, detail);
  model.onProgress?.(value);
  return value;
}
export function progressSnapshot(run, { busy = false, now = Date.now(), startedAt = now, needsResume = false } = {}) {
  const progress = run?.progress;
  const stage = run?.outcome ? 'complete' : run?.qualification?.eligible === false ? 'not_qualified' : progress?.stage || (run?.selectedClaim ? 'qualify' : 'extract');
  const total = run?.queue?.confounderIds?.length ?? null;
  const assessed = (run?.queue?.confounderIds || []).filter(id => run.review?.confounders?.[id]).length;
  const available = new Set((run?.queue?.links || []).flatMap(link => link.findings.map(row => row.raw_link_id)));
  const decisions = Object.keys(run?.review?.findings || {}).filter(id => available.has(id)).length;
  const pendingSeconds = run?.pending?.startedAt ? Math.max(0, Math.floor((now - Date.parse(run.pending.startedAt)) / 1000)) : null;
  const activePending = busy && run?.pending && Number.isFinite(Date.parse(run.pending.startedAt)) && Date.parse(run.pending.startedAt) >= startedAt;
  const sinceUpdate = progress?.updatedAt ? Math.max(0, Math.floor((now - Date.parse(progress.updatedAt)) / 1000)) : 0;
  const state = run?.outcome ? 'complete' : stage === 'not_qualified' ? 'not_qualified' : run?.pending && !activePending ? 'paused' : busy ? 'working' : needsResume ? 'paused' : 'idle';
  const title = state === 'complete' ? 'Review complete' : state === 'paused' ? 'Review paused — action needed' : state === 'not_qualified' ? 'Claim could not be qualified' : progress?.title || 'Preparing review';
  const waiting = state === 'working' && activePending ? `Waiting for the AI response${pendingSeconds === null ? '' : ` · ${pendingSeconds}s`}.` : state === 'working' && sinceUpdate >= 30 ? `Waiting for the current operation · no new update for ${sinceUpdate}s.` : '';
  return { stage, state, title, detail: progress?.detail || '', assessed, total, decisions,
    elapsedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)), pendingSeconds, waiting,
    completedCalls: run?.calls?.length || 0, available: available.size,
    // Findings may be skipped legitimately; their available count is not a promised total.
    determinate: stage === 'assess' && total !== null && total > 0,
    stageIndex: REVIEW_STAGES.findIndex(([id]) => id === stage), history: progress?.history || [] };
}
export function elapsedLabel(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
