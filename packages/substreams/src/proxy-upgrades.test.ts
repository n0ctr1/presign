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

test("recent upgrades come back newest first, one row per proxy", () => {
  const index = ProxyUpgradeIndex.create({ apiKey: "k" });
  const upgrade = (proxy: string, block: number) => ({
    proxy,
    implementation: `0x${block.toString(16).padStart(40, "0")}`,
    block,
    timestamp: 1_700_000_000 + block,
    txHash: `0x${block.toString(16)}`,
  });

  index.record(upgrade("0xaaa", 100));
  index.record(upgrade("0xbbb", 300));
  index.record(upgrade("0xccc", 200));
  // A second upgrade of the same proxy replaces the first: the index answers
  // "when did this last change", not "every change ever seen".
  index.record(upgrade("0xaaa", 400));

  assert.deepEqual(
    index.recent().map((r) => r.block),
    [400, 300, 200],
  );
  assert.deepEqual(index.recent(2).map((r) => r.proxy), ["0xaaa", "0xbbb"]);
});

/*
 * The stream delivers `txHash` as the ASCII text of the hex digits, while the
 * log's address and topics arrive as raw bytes. Encoding the text a second
 * time yields a 128-character string that looks like a hash and matches no
 * transaction anywhere — observed live, then confirmed by decoding it and
 * finding the real transaction on mainnet at the recorded block.
 */
const HASH = "7dd050139fd90563362d87e58d5e16a28edcd5a56e3af55c65c52b5bd2630cc1";

const eventWithHash = (txHash: Uint8Array): StreamedEvent => ({
  ...upgradeEvent,
  txHash,
});

test("a hash delivered as ascii hex is not encoded a second time", () => {
  const record = toUpgradeRecord(
    eventWithHash(Buffer.from(HASH, "utf8")),
    25_928_257,
    1_788_000_000,
  );

  assert.equal(record?.txHash, `0x${HASH}`);
});

test("a hash delivered as raw bytes still encodes correctly", () => {
  const record = toUpgradeRecord(
    eventWithHash(Buffer.from(HASH, "hex")),
    25_928_257,
    1_788_000_000,
  );

  // Which encoding arrives is the upstream module's business, not ours, so
  // both have to land on the same hash.
  assert.equal(record?.txHash, `0x${HASH}`);
});

/*
 * Reconnection. A gRPC stream ends — sometimes with an error, often because a
 * server closed a long-lived connection — and the first version treated that
 * as the end of the work. On the deployed service the upgrade history stopped
 * following head after half an hour and never came back.
 */
test("a bounded backfill gives up; an unbounded one keeps trying", async () => {
  /*
   * Driven against a port nothing is listening on, so every connection fails
   * immediately and the only thing under test is what the loop does about it.
   */
  const dead = "http://127.0.0.1:1";

  const bounded = ProxyUpgradeIndex.create({ apiKey: "k", endpoint: dead });
  await assert.rejects(() => bounded.run(0));
  // `run(stopBlock)` has an end by definition. Reconnecting past it would
  // ignore the argument the caller passed.
  assert.equal(bounded.live, false);

  const unbounded = ProxyUpgradeIndex.create({ apiKey: "k", endpoint: dead });
  let settled = false;
  const running = unbounded.run().then(
    () => { settled = true; },
    () => { settled = true; },
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  // Still going after the first failure, where the old version would have
  // returned and left the index frozen while it went on answering queries.
  assert.equal(settled, false);
  assert.equal(unbounded.live, false, "a stream that cannot connect is not live");
  assert.ok(unbounded.failure !== null, "the reason is recorded, not only thrown");

  unbounded.stop();
  await running;
  assert.equal(settled, true, "stop() ends the retry loop");
});

test("resuming picks up after the last block seen, never at head", () => {
  const index = ProxyUpgradeIndex.create({ apiKey: "k", startBlock: -2000 });
  index.record({
    proxy: "0xaaa",
    implementation: "0xbbb",
    block: 25_930_000,
    timestamp: 1_788_000_000,
    txHash: "0xabc",
  });

  /*
   * The index has now seen block 25 930 000. A reconnect that started at head
   * would leave a hole in the middle of the watched window while
   * `watchedSince` went on claiming it was continuous — and "no upgrade since
   * block N" would become a sentence this index has no standing to say.
   */
  assert.equal(index.watchedSince, 25_930_000);
  assert.equal(index.stats.lastBlock, 25_930_000);
});
