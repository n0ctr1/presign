# 0007 — Measure it, do not estimate it

Three commands, each of which a judge can run, each producing numbers that go
into the README dated:

- `npm run latency` — end-to-end verdict latency, cold and warm, measured on
  this build rather than inferred from component timings.
- `npm run safety` — the rules run over a set of known-safe, widely used
  contracts. A scanner that flags safe contracts is worse than a narrow one,
  so this is a release gate, not a nice-to-have. Report the tier distribution
  honestly, `unavailable` included.
- `npm run coverage` — conforming deployments counted by querying them, across
  schema families and networks. Never a hand-maintained number.

The README states nothing that one of these does not produce. If a claim
cannot be measured, soften the claim rather than the measurement.

---

**What these runs changed.** All three decisions below were taken after
reading the output, not before writing the harness:

- the gateway timeout stays at 3 s — raising it to 8 s rescued the Uniswap V3
  factory and slowed the cold path on USDC from 306 ms to 7.7 s;
- R4's "old and unindexed" finding drops to `info` and stops moving the tier —
  it was asking a human to approve Permit2, Multicall3 and the Uniswap router;
- R2's standing admin finding raises the tier only when the transaction adds
  exposure to the contract — otherwise every USDC transfer an agent makes
  would need a human, including this service's own x402 payments.

See [`../docs/AI_USAGE.md`](../docs/AI_USAGE.md) for the full reasoning.

A fourth followed later, from the live demo rather than from a harness: the
Uniswap V3 factory's standing `unavailable` was not the three-second limit at
all, but probes contending for one gateway and a failed probe being cached. See
[`0012`](./0012-live-demo-and-review-passes.md).
