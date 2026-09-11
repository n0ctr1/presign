import assert from "node:assert/strict";
import { test } from "node:test";

import { LruMap } from "../../dist/index.js";

test("past its size the least recently used entry goes, not the oldest written", () => {
  const map = new LruMap<string, number>(2);
  map.set("a", 1).set("b", 2);
  // Reading `a` makes `b` the least recently used.
  assert.equal(map.get("a"), 1);
  map.set("c", 3);

  assert.equal(map.size, 2);
  assert.equal(map.has("b"), false);
  assert.equal(map.get("a"), 1);
  assert.equal(map.get("c"), 3);
});

test("a size that could hold nothing is refused", () => {
  assert.throws(() => new LruMap(0), RangeError);
});
