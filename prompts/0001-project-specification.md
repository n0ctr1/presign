# 0001 — Project specification

*My specification for the project, written in full before any code existed —
the source file is timestamped 5 September 14:27 UTC, 51 minutes before the
first commit. Condensed here; the original is prose of the same content.*

Build a pre-signature risk advisor for agent wallets. An agent submits an
**unsigned** transaction — `from`, `to`, `value`, `data`, `chainId` — and gets
back a risk tier, the rules that fired with links to the data behind them, and
**provenance**: which deployments the answer rested on and how far behind chain
head they were.

    low     → the agent signs by itself
    medium  → confirmation on a Ledger device
    high    → refusal, with the reasoning written to HCS

We advise. We do not hold keys, do not broadcast, and do not stand in the path
of money. Co-signing would give stronger lock-in and put the project in
custodial territory; that trade is declined deliberately.

**Layer 1 — an operational layer over indexed data.** Do not rebuild subgraph
discovery; `subgraph-registry` already crawls the network meta-subgraph and
indexes thousands of subgraphs. But its reliability score is economics —
query fees, volume, curation, allocations — which means "popular and staked",
not "indexing right now". Add four things on top: conformance checked by an
actual query rather than a schema fingerprint; liveness and freshness from
`_meta { block hasIndexingErrors }` against chain head; capability binding, so
the question asked of the layer is *which deployments can answer this rule
right now within N seconds of lag*; and warming, because a verdict has a
one-second budget. Ship it as an MCP server with a `SKILL.md` so another team
can use it without touching our engine.

**Layer 2 — the verdict.** Simulation does the work: run the transaction on a
fork and read the actual state diff. Rules read the diff, not the calldata.
Three honest rules beat twenty heuristics: unlimited approval to a spender
outside the allowlist and checked against an incident registry; mutable logic
behind a proxy with a live admin; invariant breach read from the standardized
schema. **Fail closed**: if the counterparty is a known protocol and fresh
data for it is unavailable or lags past budget, the answer is *unavailable*,
never *safe*. A green verdict without fresh context must be physically
impossible. Unverified contracts are their own class — say the call was not
recognised, say how old the contract is, and rate accordingly.

**Partner slots (three, deliberately):** The Graph, Hedera, Ledger. Two-sided
x402 — the agent pays us on Hedera, we pay The Graph on Base — so the cost of
a verdict is an observable number. Two Ledger primitives, not branding: device
confirmation for the medium tier, and the Key Ring CLI instead of `.env` for
service secrets.

**What is not ours:** the pre-signature moment is taken (Hexagate), and agent
packaging is taken (Blockaid, GoPlus on x402 since March 2026). Do not claim
either. What is open is *provenance* — none of them tells you how stale the
evidence was. That is the product.

**Risks to watch:** the layer degenerating into a config file; rebuilding
discovery; false positives (run the rules over known-safe contracts before
submitting); latency; x402 on Hedera eating more than a day; spreading across
too many tracks.
