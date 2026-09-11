import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ScamSnifferIncidentFeed,
  StaticIncidentRegistry,
  toIncidentRegistry,
} from "../../dist/index.js";

const LISTED = "0x43412801d29861ecc4c4d86e5becfd16af86a67b";
const OTHER = "0x51d07e2899c0ac6058b52c6f8f352f73d3f0e2e9";
const T0 = new Date("2026-09-11T00:00:00Z");

const respond = (status: number, body: unknown) =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status }),
    )) as unknown as typeof globalThis.fetch;

test("loads the list, matching addresses regardless of case", async () => {
  const feed = new ScamSnifferIncidentFeed({
    fetch: respond(200, [LISTED.toUpperCase().replace("0X", "0x"), "not an address"]),
    now: () => T0,
  });

  assert.equal(feed.status().loaded, false);
  await feed.refresh();

  assert.equal(feed.has(LISTED), true);
  assert.equal(feed.has(OTHER), false);
  const status = feed.status();
  assert.equal(status.loaded, true);
  // Malformed entries are dropped rather than trusted.
  assert.equal(status.entries, 1);
  assert.equal(status.fetchedAt, T0.toISOString());
  assert.equal(status.lastError, null);
  // The upstream delay is stated, not left to be discovered.
  assert.match(status.note, /seven-day delay/);
});

test("a failed refresh keeps the list already loaded", async () => {
  let call = 0;
  const fetch = (() => {
    call += 1;
    return Promise.resolve(
      call === 1
        ? new Response(JSON.stringify([LISTED]), { status: 200 })
        : new Response("unavailable", { status: 503 }),
    );
  }) as unknown as typeof globalThis.fetch;
  const feed = new ScamSnifferIncidentFeed({ fetch, now: () => T0 });

  await feed.refresh();
  await feed.refresh();

  // Unlearning known drainers because upstream returned a 503 would silently
  // downgrade every flagged approval for the length of the outage.
  assert.equal(feed.has(LISTED), true);
  assert.equal(feed.status().lastError, "HTTP 503");
  assert.equal(feed.status().fetchedAt, T0.toISOString());
});

test("a list that parses to nothing is a failure, not an empty registry", async () => {
  const feed = new ScamSnifferIncidentFeed({ fetch: respond(200, { moved: true }) });
  await feed.refresh();

  assert.equal(feed.status().loaded, false);
  assert.match(String(feed.status().lastError), /JSON array/);

  const empty = new ScamSnifferIncidentFeed({ fetch: respond(200, []) });
  await empty.refresh();
  assert.match(String(empty.status().lastError), /zero addresses/);
});

test("a plain list still works where a registry is expected", () => {
  const registry = toIncidentRegistry([LISTED]);

  assert.equal(registry.has(LISTED.toUpperCase().replace("0X", "0x")), true);
  assert.equal(registry.status().entries, 1);
  assert.ok(toIncidentRegistry(new StaticIncidentRegistry([OTHER])).has(OTHER));
  assert.equal(toIncidentRegistry(undefined).status().entries, 0);
});
