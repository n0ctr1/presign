/**
 * Nonce, gas and fees for a transaction the broker is about to sign.
 *
 * All three come from the chain. They used to be optional inputs from the
 * model, which let it set a fee that hands the balance to a block builder, or
 * a future nonce that collects signatures to broadcast later. Filled before
 * the verdict is bought, so the device and the agent key sign exactly what was
 * prepared; the broker then holds them to its ceilings.
 */

import { createPublicClient, http } from "viem";

import type { ChainReader } from "./broker.js";

/** Headroom over the estimate, so a transaction does not fail for a few gas. */
const GAS_HEADROOM_PERCENT = 120n;

export function rpcChainReader(url: string): ChainReader {
  const client = createPublicClient({ transport: http(url) });

  return {
    async fill(transaction) {
      // A nonce and fee read from another chain would sign a transaction that
      // is valid nowhere, or worse, somewhere unintended.
      const served = await client.getChainId();
      if (served !== transaction.chainId) {
        throw new Error(`the RPC serves chain ${served}, not chain ${transaction.chainId}`);
      }

      const [nonce, fees, estimate] = await Promise.all([
        client.getTransactionCount({ address: transaction.from, blockTag: "pending" }),
        client.estimateFeesPerGas() as Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>,
        client.estimateGas({
          account: transaction.from,
          ...(transaction.to === null ? {} : { to: transaction.to }),
          value: transaction.value,
          data: transaction.data,
        }),
      ]);

      return {
        nonce,
        gas: (estimate * GAS_HEADROOM_PERCENT) / 100n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },
  };
}
