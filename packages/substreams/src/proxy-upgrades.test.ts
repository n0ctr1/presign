import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProxyUpgradeIndex,
  toUpgradeRecord,
  UPGRADED_TOPIC,
} from "../dist/index.js";
import type { StreamedEvent, UpgradeRecord } from "../dist/index.js";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

const PROXY = "0xf6b4b7959111d0c1f6ef9261e958dd131bd638cc";
const IMPL = "0x000100abaad02f1cfc8bbe32bd5a564817339e72";
const TOPIC_IMPL = `0x${"00".repeat(12)}${IMPL.slice(2)}`;

/** Shaped exactly as the stream delivers it, taken from a live run. */
const upgradeEvent: StreamedEvent = {
  txHash: bytes("0xf58d0ed07ae805a1e972ca52ccab2a37b2d741b14dfe561e3c758e5d409748a1"),
  log: {
    address: bytes(PROXY),
    topics: [bytes(UPGRADED_TOPIC), bytes(TOPIC_IMPL)],
  },
};

test("decodes a proxy upgrade into proxy and implementation", () => {
  const record = toUpgradeRecord(upgradeEvent, 25926890, 1_788_800_000);

  assert.ok(record);
  assert.equal(record.proxy, PROXY);
  // The implementation is an address in the low 20 bytes of a 32-byte topic.
  assert.equal(record.implementation, IMPL);
  assert.equal(record.block, 25926890);
  assert.equal(record.timestamp, 1_788_800_000);
});

test("rejects an event whose topic is not Upgraded", () => {
  /*
   * The regression this exists for. Passing the filter to `createRequest`
   * instead of `applyParams` is silently ignored: the module keeps the
   * package's default signature and streams a completely different event,
   * while everything about the stream looks healthy. That happened, and this
   * is the guard that stops those events being recorded as upgrades.
   */
  const wrongTopic: StreamedEvent = {
    ...upgradeEvent,
    log: {
      address: bytes(PROXY),
      topics: [
        bytes("0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31"),
        bytes(TOPIC_IMPL),
      ],
    },
  };

  assert.equal(toUpgradeRecord(wrongTopic, 1, 1), null);
});

test("rejects an event with no proxy address rather than keying on empty", () => {
  const malformed: StreamedEvent = {
    log: { topics: [bytes(UPGRADED_TOPIC), bytes(TOPIC_IMPL)] },
  };

  // Recording this would put an unqueryable key in the index.
  assert.equal(toUpgradeRecord(malformed, 1, 1), null);
});

const index = () =>
  ProxyUpgradeIndex.create({ apiKey: "unused", packagePath: "unused" });

const record = (over: Partial<UpgradeRecord> = {}): UpgradeRecord => ({
  proxy: PROXY,
  implementation: IMPL,
  block: 100,
  timestamp: 1_788_800_000,
  txHash: "0xabc",
  ...over,
});

test("an unseen proxy is unknown, not proven never upgraded", () => {
  const idx = index();
  idx.record(record());

  // The index only knows the window it watched. A rule reading null must treat
  // it as "no information", which is why watchedSince is published beside it.
  assert.equal(idx.lastUpgrade("0xdead000000000000000000000000000000000000"), null);
  assert.equal(idx.watchedSince, 100);
});

test("keeps the most recent upgrade per proxy", () => {
  const idx = index();
  idx.record(record({ block: 100, implementation: "0x1111111111111111111111111111111111111111" }));
  idx.record(record({ block: 250, implementation: "0x2222222222222222222222222222222222222222" }));

  assert.equal(idx.lastUpgrade(PROXY)?.block, 250);
  assert.equal(
    idx.lastUpgrade(PROXY)?.implementation,
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(idx.stats.proxies, 1);
});

test("lookup is case-insensitive, since callers hold checksummed addresses", () => {
  const idx = index();
  idx.record(record());

  assert.ok(idx.lastUpgrade(PROXY.toUpperCase().replace("0X", "0x")));
});

test("tracks the watched window so absence can be interpreted", () => {
  const idx = index();
  idx.record(record({ block: 500 }));
  idx.record(record({ proxy: "0x1111111111111111111111111111111111111111", block: 300 }));

  // firstBlock is the first seen, lastBlock the highest — an out-of-order
  // record must not shrink the window and make it look narrower than it was.
  assert.equal(idx.stats.firstBlock, 500);
  assert.equal(idx.stats.lastBlock, 500);
  assert.equal(idx.stats.proxies, 2);
});
