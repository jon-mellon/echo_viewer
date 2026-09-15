import test from "node:test";
import assert from "node:assert/strict";
import { DAG_EXPORT_HEIGHT, DAG_EXPORT_WIDTH, fitDagImage } from "../site/dag_export_image.mjs";

test("DAG image export has a fixed 4:3 canvas and contains portrait or landscape graphs", () => {
  assert.equal(DAG_EXPORT_WIDTH / DAG_EXPORT_HEIGHT, 4 / 3);
  for (const [width, height] of [[1600, 900], [500, 1200], [2000, 400]]) {
    const fitted = fitDagImage(width, height);
    assert.ok(fitted.x >= 0 && fitted.y >= 0);
    assert.ok(fitted.x + fitted.width <= DAG_EXPORT_WIDTH);
    assert.ok(fitted.y + fitted.height <= DAG_EXPORT_HEIGHT);
    assert.equal(fitted.width / fitted.height, width / height);
  }
});
