import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as renderer from "../site/map_canvas_renderer.mjs";
import * as geometry from "../site/map_geometry.mjs";
import * as model from "../site/map_render_model.mjs";

function recorder() {
  const commands = [];
  const ctx = new Proxy({}, {
    get: (_, key) => (...args) => commands.push([key, ...args]),
    set: (_, key, value) => { commands.push([key, value]); return true; },
  });
  return { ctx, commands };
}

test("canvas commands match legacy for regions, halos, cells, badges and brushes", () => {
  const transform = { scale: 2, tx: 10, ty: 20 };
  const colors = { active: "#b83b5e", iv: "#315f9d", dv: "#9b5c2e", assigned: "#1f7a67" };
  const poly = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }];
  const cells = new Map([["a", poly]]);
  const variables = [{ variable_id: "a", map_x: 5, map_y: 5, cluster_size: 4, uoa: "x" }];
  const state = {
    variableById: new Map(variables.map(v => [v.variable_id, v])),
    project: { groups: [] }, selectedVariableIds: new Set(), selectedVariableId: "a",
    map: { transform }, uoaFilterEnabled: true, selectedUoa: "x",
  };
  const legacy = vm.createContext({
    state, GROUP_COLORS: colors, mapRenderModel: model, mapGeometry: geometry,
    worldToScreen: (x, y) => geometry.worldToScreen(x, y, transform),
    ensureGlobalVoronoiCells: () => cells, visibleClusterReps: () => variables,
    canvasWidth: () => 200, canvasHeight: () => 150,
    groupColor: () => colors.assigned, clusterRep: id => id,
    uoaMatches: (a, b) => a === b, variableColor: () => colors.assigned,
  });
  vm.runInContext(readFileSync(new URL("./fixtures/legacy_map_canvas.js", import.meta.url), "utf8"), legacy);
  const compare = (oldDraw, newDraw) => {
    const a = recorder(), b = recorder();
    oldDraw(a.ctx); newDraw(b.ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(b.commands)), JSON.parse(JSON.stringify(a.commands)));
  };
  const options = { transform, variables: state.variableById, colors, color: colors.assigned, width: 200, height: 150 };
  compare(ctx => legacy.drawVoronoiBackground(ctx, 200, 150), ctx => renderer.drawVoronoiBackground(ctx, cells, 200, 150, transform));
  for (const active of [false, true]) {
    const group = { type: "iv", variable_ids: ["a", "missing"], boundary_geometry: { polygons: [
      { action: "add", points: poly }, { action: "remove", points: poly },
    ] } };
    compare(ctx => legacy.drawGroupMemberHalos(ctx, group, active), ctx => renderer.drawGroupMemberHalos(ctx, group, active, options));
    compare(ctx => legacy.drawStoredGroupPolygons(ctx, group, active), ctx => renderer.drawStoredGroupPolygons(ctx, group, active, options));
    const region = { territories: [poly] };
    compare(ctx => legacy.drawGroupRegion(ctx, group, region, active), ctx => renderer.drawGroupRegion(ctx, region, active, options));
  }
  for (const action of ["add", "remove", "select_vars"]) for (const points of [[], poly.slice(0, 1), poly]) {
    state.map.brush = { action, points };
    compare(ctx => legacy.drawBrush(ctx), ctx => renderer.drawBrush(ctx, state.map.brush, colors));
  }
  for (const uoa of ["x", "y"]) {
    state.selectedUoa = uoa;
    const points = model.buildMapPointModels({
      ...state, variables, groups: [], transform, width: 200, height: 150,
      clusterRep: id => id, worldToScreen: geometry.worldToScreen,
      uoaMatches: (a, b) => a === b, variableColorForStatus: () => colors.assigned,
    });
    compare(ctx => legacy.drawMapPoints(ctx, 200, 150), ctx => renderer.drawMapPoints(ctx, points));
  }
});

test("browser Voronoi rendering compiles immutable world geometry once", () => {
  const priorPath2D = globalThis.Path2D;
  const paths = [];
  globalThis.Path2D = class {
    constructor() { this.commands = []; paths.push(this); }
    moveTo(...args) { this.commands.push(["moveTo", ...args]); }
    lineTo(...args) { this.commands.push(["lineTo", ...args]); }
    closePath(...args) { this.commands.push(["closePath", ...args]); }
  };
  try {
    const cells = new Map([["a", [
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 },
    ]]]);
    const first = recorder();
    const second = recorder();
    renderer.drawVoronoiBackground(first.ctx, cells, 200, 150, { scale: 2, tx: 10, ty: 20 });
    renderer.drawVoronoiBackground(second.ctx, cells, 200, 150, { scale: 4, tx: 30, ty: 40 });

    assert.equal(paths.length, 1);
    assert.deepEqual(paths[0].commands, [
      ["moveTo", 0, 0], ["lineTo", 2, 0], ["lineTo", 2, 1], ["closePath"],
    ]);
    assert.ok(first.commands.some(command => command[0] === "transform" && command[1] === 2));
    assert.ok(second.commands.some(command => command[0] === "transform" && command[1] === 4));
    assert.ok(first.commands.some(command => command[0] === "lineWidth" && command[1] === 0.3));
    assert.ok(second.commands.some(command => command[0] === "lineWidth" && command[1] === 0.15));
    assert.equal(first.commands.find(command => command[0] === "stroke")[1], paths[0]);
    assert.equal(second.commands.find(command => command[0] === "stroke")[1], paths[0]);
  } finally {
    if (priorPath2D === undefined) delete globalThis.Path2D;
    else globalThis.Path2D = priorPath2D;
  }
});
