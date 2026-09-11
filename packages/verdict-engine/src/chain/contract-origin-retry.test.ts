import assert from "node:assert/strict";
import { test } from "node:test";

import { RpcContractOrigin } from "../../dist/index.js";

const HEAD = 1_000_000;
const HEAD_TIME = 1_789_000_000;

test("an age that could not be established is asked again, not remembered", async () => {
  let failing = true;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    if (failing) return { ok: false, status: 503, json: () => Promise.resolve({}) };
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    const result =
      method === "eth_getBlockByNumber"
        ? (() => {
            const tag = params[0] as string;
            const number = tag === "latest" ? HEAD : Number.parseInt(tag, 16);
            return { number: `0x${number.toString(16)}`, timestamp: `0x${(HEAD_TIME - (HEAD - number) * 12).toString(16)}` };
          })()
        : "0x6080"; // code everywhere: the contract predates the horizon
    return { ok: true, status: 200, json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result }) };
  }) as unknown as typeof globalThis.fetch;

  const origin = new RpcContractOrigin({ url: "https://archive.example", fetch: fetchImpl });
  const address = "0x1111111111111111111111111111111111111111" as never;

  assert.equal((await origin.originOf(address)).status, "indeterminate");

  // One 503 used to make this address "of unknown age" for the life of the
  // process. The next verdict asks again and gets the real answer.
  failing = false;
  assert.equal((await origin.originOf(address)).status, "older_than");
});
