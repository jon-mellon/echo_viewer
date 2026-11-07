// Randomized stateful (model-based) fuzzing of the pure project operations,
// replaying them the way dag_builder.js / dag_project_controller.mjs do:
// snapshot -> operation -> addDecision -> snapshot -> recordHistory; undo/redo via historyStep.
import * as P from "../../site/dag_project.mjs";
import * as H from "../../site/project_history.mjs";
import * as V from "../../site/variable_visibility.mjs";

const VARS = Array.from({ length: 24 }, (_, i) => `v${i}`);
export const clusterOf = new Map();
export const clusterMembers = new Map();
for (const [rep, ms] of [["v0", ["v0", "v1"]], ["v5", ["v5", "v6", "v7"]]]) {
  clusterMembers.set(rep, ms);
  for (const m of ms) clusterOf.set(m, rep);
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function initial() {
  const p = P.createProject({ projectId: "p", groupingSetId: "gs" });
  const mk = (id, ids, type) => ({ group_id: id, label: id, variable_ids: ids, seed_variable_ids: ids.slice(),
    excluded_nearby_variable_ids: [], boundary_geometry: {}, notes: "", type, created_at: "t0", updated_at: "t0" });
  p.groups = [mk("g_iv", ["v0", "v1"], "iv"), mk("g_dv", ["v2"], "dv"), mk("a", ["v3", "v4", "v5", "v6", "v7"], "candidate"),
    mk("b", ["v8", "v9", "v10"], "candidate"), mk("c", ["v11", "v12"], "candidate"), mk("d", ["v13"], "candidate")];
  return p;
}

export function check(app) {
  const p = app.project, errs = [];
  const ids = p.groups.map(g => g.group_id);
  if (new Set(ids).size !== ids.length) errs.push("duplicate group ids");
  for (const k of ["iv_group_id", "dv_group_id", "instrument_group_id"]) {
    if (p[k] && !ids.includes(p[k])) errs.push(`${k}=${p[k]} dangling`);
  }
  if (p.iv_group_id && p.iv_group_id === p.dv_group_id) errs.push("iv==dv");
  if (p.instrument_group_id && [p.iv_group_id, p.dv_group_id].includes(p.instrument_group_id)) errs.push("instrument is anchor");
  for (const side of ["iv", "dv"]) {
    const typed = p.groups.filter(g => g.type === side).map(g => g.group_id);
    const want = p[`${side}_group_id`] ? [p[`${side}_group_id`]] : [];
    if (JSON.stringify(typed) !== JSON.stringify(want)) errs.push(`type=${side} groups ${JSON.stringify(typed)} vs ${side}_group_id=${JSON.stringify(p[side + "_group_id"])}`);
  }
  const owner = new Map();
  for (const g of p.groups) for (const v of g.variable_ids || []) {
    if (owner.has(v)) errs.push(`${v} in ${owner.get(v)} and ${g.group_id}`);
    owner.set(v, g.group_id);
  }
  for (const [rep, ms] of clusterMembers) {
    const os = new Set(ms.map(m => owner.get(m)).filter(Boolean));
    if (os.size > 1) errs.push(`cluster ${rep} split across ${[...os]}`);
  }
  const labels = p.groups.map(g => (g.label || "").trim().toLowerCase()).filter(Boolean);
  const dids = p.decisions.map(d => d.decision_id);
  if (new Set(dids).size !== dids.length) errs.push("duplicate decision ids");
  const rej = V.rejectedIds(p.rejected_variables, clusterOf, clusterMembers);
  for (const r of p.restored_variable_ids || []) if (rej.has(r)) errs.push(`${r} both rejected and restored`);
  return errs;
}

const nowIso = (() => { let n = 0; return () => `t${++n}`; })();
function addDecision(app, type, payload) {
  app.project.decisions = [...app.project.decisions, { decision_id: `decision_${app.project.decisions.length + 1}`, type, timestamp: nowIso(), payload }];
}
function snap(app, kind) {
  return kind === "anchors" ? P.snapshotAnchors(app.project, app.phase) : P.snapshotProject(app.project, app.phase);
}
function commit(app, desc, kind, fn) {
  const before = snap(app, kind);
  fn();
  const after = snap(app, kind);
  const h = H.recordHistory(app, desc, before, after, nowIso(), kind === "anchors" ? "anchors" : "full");
  if (h) Object.assign(app, h);
}
function pick(r, a) { return a[Math.floor(r() * a.length)]; }
const safe = fn => { try { fn(); } catch (e) { if (e.name !== "Error") throw e; } };

export function makeOps(r) {
  let nid = 0;
  const groups = app => app.project.groups;
  const anyGroup = app => pick(r, groups(app));
  const someVars = () => Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, VARS));
  const mem = v => V.members(v, clusterOf, clusterMembers);
  return {
    promoteIv: app => commit(app, "promote iv", "anchors", () => { app.project = P.promoteAnchor(app.project, "iv", anyGroup(app).group_id, nowIso()); }),
    promoteDv: app => commit(app, "promote dv", "anchors", () => { app.project = P.promoteAnchor(app.project, "dv", anyGroup(app).group_id, nowIso()); }),
    clearIv: app => commit(app, "clear iv", "anchors", () => { app.project = P.clearAnchor(app.project, "iv"); }),
    clearDv: app => commit(app, "clear dv", "anchors", () => { app.project = P.clearAnchor(app.project, "dv"); }),
    addMembers: app => commit(app, "add members", "full", () => { app.project = P.addMembers(app.project, anyGroup(app).group_id, someVars().flatMap(mem), nowIso()); }),
    exclude: app => {
      const g = anyGroup(app); if (!g.variable_ids.length) return; const v = pick(r, g.variable_ids);
      commit(app, "exclude", "full", () => { app.project = P.removeMembers(app.project, g.group_id, mem(v), nowIso()); addDecision(app, "concept_excluded", { v }); });
    },
    rename: app => { const g = anyGroup(app); commit(app, "rename", "full", () => { app.project = P.updateGroup(app.project, g.group_id, { label: pick(r, ["a", "b", "c", "x", "y", "Orig"]) }); }); },
    reject: app => commit(app, "reject", "full", () => { const v = pick(r, VARS); app.project = V.rejectVariables(app.project, [{ variable_id: V.representative(v, clusterOf), reason: "r" }], clusterOf, clusterMembers); }),
    restoreRej: app => { const e = app.project.rejected_variables; if (!e.length) return; commit(app, "restore rej", "full", () => { app.project = V.restoreRejection(app.project, pick(r, e).variable_id, clusterOf, clusterMembers); }); },
    linkDecision: app => commit(app, "link dec", "full", () => { app.project = P.setLinkDecision(app.project, pick(r, ["e1", "e2", "e3"]), r() < .3 ? null : { status: "accepted" }); }),
    split: app => {
      const src = [...new Set([anyGroup(app), anyGroup(app)])].filter(g => g.variable_ids.length > 1);
      if (!src.length) return;
      const pool = src.flatMap(g => g.variable_ids);
      const carved = [...new Set(Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(r, pool)))];
      const closed = [...new Set(carved.flatMap(mem).filter(v => pool.includes(v)))];
      const id = `s${nid++}`; const role = pick(r, [undefined, undefined, "iv", "dv", "instrument"]);
      const residualLabels = Object.fromEntries(src.map(g => [g.group_id, `${g.label}-rest${nid}`]));
      safe(() => commit(app, "split", "full", () => { app.project = P.splitCategories(app.project, { sourceGroupIds: src.map(g => g.group_id), newGroupId: id, newLabel: `New ${id}`, residualLabels, newVariableIds: closed, timestamp: nowIso(), role }); }));
    },
    editSplit: app => {
      const g = groups(app).find(x => x.source === "user_split"); if (!g) return;
      const ctx = P.editableSplitContext(app.project, g); if (!ctx) return;
      const pool = [ctx.newGroup, ...ctx.residuals].flatMap(x => x.variable_ids);
      const carved = [...new Set(Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(r, pool)).flatMap(mem).filter(v => pool.includes(v)))];
      safe(() => commit(app, "edit split", "full", () => { app.project = P.updateSplitCategories(app.project, { sourceGroupIds: ctx.residuals.map(x => x.group_id), newGroupId: g.group_id, newLabel: g.label, residualLabels: Object.fromEntries(ctx.residuals.map(x => [x.group_id, x.label])), newVariableIds: carved, timestamp: nowIso(), role: undefined, splitId: ctx.splitId }); }));
    },
    deleteSplit: app => {
      const g = groups(app).find(x => x.source === "user_split"); if (!g) return;
      safe(() => commit(app, "delete split", "full", () => { app.project = P.deleteSplitCategories(app.project, { groupId: g.group_id, timestamp: nowIso() }); }));
    },
    undo: app => step(app, "undo"), redo: app => step(app, "redo"),
    undo2: app => { step(app, "undo"); step(app, "undo"); },
    redo2: app => { step(app, "redo"); step(app, "redo"); },
  };
}
function step(app, dir) {
  const hs = H.historyStep(app, dir); if (!hs) return;
  app.undoPointer = hs.undoPointer;
  const restored = P.restoreSnapshot(app.project, hs.snapshot);
  app.project = restored.project; app.phase = restored.phase;
}

export function run(seed, steps = 12) {
  const r = rng(seed); const ops = makeOps(r); const names = Object.keys(ops);
  const app = { project: initial(), phase: "build", undoHistory: [], undoPointer: -1, actionLog: [] };
  const trace = [];
  for (let i = 0; i < steps; i++) {
    const name = pick(r, names); trace.push(name);
    ops[name](app);
    const errs = check(app);
    if (errs.length) return { seed, trace, errs, app };
  }
  return null;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const found = new Map();
  for (let s = 1; s <= 4000; s++) {
    const f = run(s, 6 + (s % 10));
    if (!f) continue;
    const key = f.errs[0].replace(/\d+|v\d+|s\d+/g, "#");
    if (!found.has(key) || found.get(key).trace.length > f.trace.length) found.set(key, f);
  }
  for (const [k, f] of found) console.log(k, "\n  seed", f.seed, f.trace.join(" > "), "\n  ", f.errs.join("; "));
  console.log(found.size, "distinct invariant classes");
}
