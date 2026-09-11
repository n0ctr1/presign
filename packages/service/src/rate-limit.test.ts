import assert from "node:assert/strict";
import { test } from "node:test";

import { createRateLimiter } from "../dist/index.js";

test("allows the ceiling per minute, then says when to come back", () => {
  let clock = 0;
  const limiter = createRateLimiter({ perMinute: 3, now: () => clock });

  for (let i = 0; i < 3; i++) assert.equal(limiter.take("a").ok, true);
  const refused = limiter.take("a");
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.retryAfterSeconds === 60);

  // Another client is not punished for the first one.
  assert.equal(limiter.take("b").ok, true);

  clock += 60_001;
  assert.equal(limiter.take("a").ok, true);
});

test("forgets the least recently seen client first", () => {
  let clock = 0;
  const limiter = createRateLimiter({ perMinute: 1, now: () => clock, maxClients: 2 });

  limiter.take("a");
  clock += 1;
  limiter.take("b");
  clock += 1;
  limiter.take("c"); // evicts "a"

  // "a" was forgotten, so it may ask again; "c" is still remembered.
  assert.equal(limiter.take("a").ok, true);
  assert.equal(limiter.take("c").ok, false);
});
