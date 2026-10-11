import assert from "node:assert/strict";
import { test } from "node:test";
import { cappedKeyStatus } from "../site/definition_jev_assist.mjs";

test("Jev access requires a non-resetting key capped at $5", () => {
  assert.equal(cappedKeyStatus({ limit: 5, limit_reset: null, limit_remaining: 4.5 }), null);
  assert.match(cappedKeyStatus({ limit: null, limit_reset: null, limit_remaining: null }), /Set a spending limit/);
  assert.match(cappedKeyStatus({ limit: 5.01, limit_reset: null, limit_remaining: 5.01 }), /Lower its limit/);
  assert.match(cappedKeyStatus({ limit: 5, limit_reset: "daily", limit_remaining: 5 }), /never resets/);
  assert.match(cappedKeyStatus({ limit: 5, limit_reset: null, limit_remaining: 0 }), /no spending allowance/);
});
