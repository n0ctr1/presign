# @presign/verdict-engine

Turns an **unsigned** transaction into a risk verdict by running it and reading
what it actually changed.

```
low          agent signs on its own
medium       escalate to on-device human confirmation
high         do not sign
unavailable  do not sign — fresh context was unobtainable, which is not "safe"
```

## Rules read the diff, not the calldata

Calldata says what a transaction *claims* to do. The state diff says what it
*does*. The two part company exactly where it matters: a router, a batch, a
multicall or a forwarded `permit` shows nothing useful on the surface and an
unmistakable allowance write in the diff.

| Rule | Reads | Catches |
|---|---|---|
| **R1** | simulated state diff | Unlimited approval to a spender outside the allowlist |
| **R2** | proxy storage slots | Replaceable implementation; admin with no timelock |
| **R3** | indexed protocol data | Protocol accounting that does not add up |

### R1 proves the slot is an allowance

Rather than decoding `approve`, R1 takes each storage slot the transaction
wrote and tries to prove it *is* `allowance[owner][spender]` by recomputing

```
keccak256(spender ‖ keccak256(owner ‖ p))
```

for each plausible mapping position `p`. A match is a proof under Solidity's
mapping layout, not a heuristic, and it needs no per-token configuration —
USDC's mapping position (10) is recovered by search. An unrelated large write
therefore produces nothing.

### R2 reads slots, not getters

`implementation()` and `admin()` are usually admin-only and revert for everyone
else, and a proxy that wants to hide simply will not implement them. The
storage slots are where a proxy must keep those values in order to function, so
they cannot be withheld. Slot constants are recomputed from their EIP preimages
in the tests; if one drifts, every proxy check would silently start reading
zeros and report "immutable" for everything.

### R3 is why fail-closed is load-bearing

R1 and R2 need only an RPC. R3 is the one rule that needs indexed protocol
data, so it is the one that can go stale — and `RuleOutcome` makes the
distinction structural:

```ts
type RuleOutcome =
  | { status: "evaluated"; findings; sources? }
  | { status: "unavailable"; reason; detail };
```

An empty finding list means "I looked and found nothing wrong". A rule that
could not obtain fresh context must say something different. If both were an
empty array, the engine could not tell them apart — which is exactly how a
green verdict gets issued on absent data.

**Source selection is the subtle part.** Appearing in a subgraph's manifest
does not make a contract an instance of that subgraph's protocol: USDC is
indexed by Hop's and SOMA's subgraphs, and treating it as "a DEX" on that basis
then checking pool invariants against it is a category error. So conformance
and liveness are read as answers to different questions:

- **Conformance asks what the counterparty is.** A deployment claiming a family
  it cannot answer means the classification is unreliable, and R3 has nothing
  to say — `evaluated([])`.
- **Liveness asks whether we can see it now.** A conforming deployment past the
  freshness budget means this *is* the protocol and we currently cannot check
  it — `unavailable`.

**Invariants are impossible states, not thresholds.** Borrows exceeding
deposits, negative balances, value locked against zero underlying, shares
against no assets. A market at 99.9% utilisation is alarming to a human and
entirely legitimate; there is a test asserting it produces nothing. A scanner
that flags healthy protocols is worse than one with narrow coverage.

## Tiering

Severity maps to a tier, then a policy ceiling applies to **standing** findings
— things true of every call to a contract rather than of this call.

`R2` is capped at `medium` by default. "This contract is upgradeable" is true
of most real counterparties, USDC included, whose proxy admin is a plain EOA
with no timelock (verified on mainnet). Letting that reach `high` would refuse
most honest transactions and train callers to ignore the verdict. Medium is the
honest response: a human looks at it. The cap does **not** apply to findings
about the transaction itself, so an implementation swap inside the call under
judgement still reaches `high`.

Two orderings matter when folding:

- A definite finding outranks uncertainty. If a rule proved something wrong,
  the caller hears that rather than "could not evaluate".
- The *absence* of findings does not outrank uncertainty. A clean result from
  the rules that ran says nothing about the rule that could not run, so
  `low + any unavailable` becomes `unavailable`.

## Simulation

`debug_traceCall` with the prestate tracer in diff mode, against an Anvil fork
running `--no-mining` so state cannot move while a verdict is being formed.
Revert is detected with a separate `eth_call` rather than inferred from an
empty diff — a reverted transaction still produces a non-empty prestate, and
reporting an approval that never lands teaches callers to ignore the rule.

**Forking needs an archive-capable RPC.** Public endpoints serve only recent
state; a fork left running drifts out of that window and then fails with
`Archive requests require a personal token`. Pin `forkBlockNumber` and
re-anchor periodically, or point at an archive provider.

## Measured

Against a live mainnet fork:

| | |
|---|---|
| R1, unlimited approval detected with slot proof | 48 ms |
| R2, proxy classification | ~200 ms |
| R3, identify + probe + query + check | ~2.8 s cold |
