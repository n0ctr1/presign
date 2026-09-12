/**
 * The three transactions the landing page can ask about.
 *
 * Fixed rather than free-form, and that is a design choice rather than a
 * limitation: a public endpoint that simulates anything anyone sends is an
 * abuse surface held back by rate limits you have to trust, while a fixed set
 * is bounded by construction and can be cached. Agents get the open door —
 * `/quote`, the paid routes, `llms.txt` — because they arrive with a payment.
 *
 * The three are chosen to answer the three questions a reader has. Does it
 * catch the obvious theft? Does freshness actually change the answer? And the
 * one every scanner fails: does it shout at ordinary traffic too?
 */

import type { UnsignedTransaction } from "@presign/verdict-engine";

const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
/** Holds USDC on mainnet, so a transfer of it simulates as a real one. */
const USDC_HOLDER = "0x37305b1cd40574e4c5ce33f8e8306be057fd7341";
const AAVE_V3_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
/** On ScamSniffer's open blacklist, which R1 checks every verdict against. */
const LISTED = "0x43412801d29861ecc4c4d86e5becfd16af86a67b";
const ORDINARY = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

const word = (address: string) => address.slice(2).padStart(64, "0");
const approve = (spender: string, amount: string) => `0x095ea7b3${word(spender)}${amount}`;
const transfer = (to: string, amount: bigint) =>
  `0xa9059cbb${word(to)}${amount.toString(16).padStart(64, "0")}`;

/** One of the fixed transactions the landing page can ask about. */
export interface DemoExample {
  readonly id: string;
  readonly title: string;
  /** One line saying what the transaction is and what to expect. */
  readonly detail: string;
  readonly transaction: UnsignedTransaction;
  /** True when the freshness budget changes the answer, so the page offers the slider. */
  readonly budgetMatters: boolean;
}

export const DEMO_EXAMPLES: readonly DemoExample[] = [
  {
    id: "blacklisted-approval",
    title: "Unlimited USDC approval to an address on ScamSniffer's blacklist",
    detail:
      "The allowance is read from the simulated state diff, not from the calldata, and the spender is on a list fetched at startup and every six hours.",
    transaction: {
      from: AGENT,
      to: USDC,
      value: 0n,
      data: approve(LISTED, "f".repeat(64)),
      chainId: 1,
    } as UnsignedTransaction,
    budgetMatters: false,
  },
  {
    id: "aave-pool",
    title: "A call to the Aave V3 pool, under a freshness budget you choose",
    detail:
      "Same call, same protocol, same indexed data. Only the budget differs: inside it the verdict names the deployment that answered and how far behind head it was; outside it there is no verdict at all.",
    transaction: {
      from: AGENT,
      to: AAVE_V3_POOL,
      value: 0n,
      // getReservesList(), a view any caller may send.
      data: "0xd1946dbc",
      chainId: 1,
    } as UnsignedTransaction,
    budgetMatters: true,
  },
  {
    id: "usdc-transfer",
    title: "Sending 1 USDC to an ordinary address",
    detail:
      "The counterparty is an upgradeable proxy and the verdict says so — at `info`, because this transaction adds no exposure to it. A scanner that called this dangerous would be one nobody reads twice.",
    transaction: {
      from: USDC_HOLDER,
      to: USDC,
      value: 0n,
      data: transfer(ORDINARY, 1_000_000n),
      chainId: 1,
    } as UnsignedTransaction,
    budgetMatters: false,
  },
];

/**
 * Freshness budgets the page may ask for, in seconds.
 *
 * Stops rather than a free number, because each one is a rule instance the
 * process builds at start-up, and because the interesting range is small: one
 * second refuses, thirty seconds answers.
 */
export const DEMO_BUDGETS: readonly number[] = [1, 5, 15, 30, 60];
