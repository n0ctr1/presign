import assert from "node:assert/strict";
import { test } from "node:test";

import { createMeter, meteredQuote } from "../dist/index.js";
import type { UnsignedTransaction } from "@presign/verdict-engine";

const tx = (to: string | null) =>
  ({ from: "0x0000000000000000000000000000000000000001", to, value: 0n, data: "0x", chainId: 1 }) as UnsignedTransaction;

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

test("a counterparty R3 reads nothing for pays the base price alone", () => {
  // USDC: no conforming deployment speaks for it, so the verdict buys no
  // indexed data, and charging it the flat surcharge was charging for nothing.
  const quote = meteredQuote(0);
  assert.equal(quote.hbar, "0.001");
  assert.equal(quote.deployments, 0);
});

test("each deployment R3 reads adds to the price, and the breakdown says how many", () => {
  const quote = meteredQuote(3);
  assert.equal(quote.hbar, "0.004");
  assert.match(quote.breakdown[1]!.item, /3 deployments at 0\.001 HBAR each/);
});

test("the price stops at the ceiling and says it was capped", () => {
  const quote = meteredQuote(20);
  assert.equal(quote.hbar, "0.009");
  assert.match(quote.breakdown[1]!.item, /8 deployments of 20, capped/);
});

test("a count that failed is priced at the ceiling and says why", () => {
  const quote = meteredQuote(null);
  assert.equal(quote.hbar, "0.009");
  assert.match(quote.breakdown[1]!.item, /could not be counted/);
});

test("the price holds between the 402 and the paid retry", async () => {
  let counted = 0;
  let clock = 0;
  const meter = createMeter({
    count: (t) => {
      counted += 1;
      return Promise.resolve(t.to === POOL ? 3 : 0);
    },
    now: () => clock,
  });

  const first = await meter.quote(tx(POOL));
  clock += 10_000; // the paid retry, seconds later
  const retry = await meter.quote(tx(POOL));

  // Priced twice by the exchange, counted once: a count that moved in between
  // would reject a payment the caller made in good faith.
  assert.equal(first.tinybars, retry.tinybars);
  assert.equal(counted, 1);

  clock += 301_000;
  await meter.quote(tx(POOL));
  assert.equal(counted, 2);

  assert.equal((await meter.quote(tx(USDC))).hbar, "0.001");
});

test("concurrent quotes for one counterparty share a single count", async () => {
  let counted = 0;
  const meter = createMeter({
    count: () => {
      counted += 1;
      return new Promise((resolve) => setTimeout(() => resolve(2), 10));
    },
  });

  const quotes = await Promise.all([meter.quote(tx(POOL)), meter.quote(tx(POOL))]);
  assert.equal(counted, 1);
  assert.equal(quotes[0]!.hbar, quotes[1]!.hbar);
});
