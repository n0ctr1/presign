# presign

**Risk verdicts for agent wallets that declare how stale their evidence was.**

An autonomous agent holding a key signs whatever its planner hands it. `presign`
answers one question before that signature — *is this safe to sign?* — and
attaches the thing that makes the answer checkable: which data it rested on, and
how far behind chain head that data was.

The second half is the part nobody else returns.

## The claim, demonstrated

Same call to the Aave V3 pool. Same indexed data, same code path, same rules.
Only the freshness budget differs:

```
budget 30s  →  low          source: Aave V3 Ethereum (QmcXE5QVcBcv…), lag 12.3s
budget  1s  →  unavailable  R3 could not run: all_candidates_stale
```

A clean verdict is not merely unlikely without fresh context — it is
unreachable. `unavailable` is a separate outcome in the type system rather than
a softer way of saying `low`, so a rule that cannot obtain fresh data has no way
to report "nothing found". Both rows above come from `npm run demo`.

## Why this rather than an existing scanner

Pre-signature simulation is not new. Hexagate, Blockaid and GoPlus all do it, and
the agent-facing packaging — MCP servers, LangChain tools, pay-per-call x402
endpoints — is already shipped. **Acting before the signature is not a
differentiator, and this repo does not claim it as one.**

What none of them return is how fresh the evidence was. A green verdict computed
from a subgraph six hours behind chain head is indistinguishable from one
computed at chain head. On a dashboard that is a footnote. Immediately before a
signature it is the entire risk.

Three things follow, and each is load-bearing rather than decorative:

1. **Lag is in the response.** Every verdict names the deployments it was
   computed from and how many seconds behind head each one was — including when
   nothing was found, because "no problems" and "no problems according to a
   deployment four seconds behind head" are different claims and only the second
   can be checked.
2. **Fail-closed on stale context.** If the counterparty is a pool or market of a
   known protocol and fresh data for it is unavailable or past budget, the answer
   is `unavailable`, never `safe`.
3. **The data layer ships separately.** It is exposed as an MCP server with a
   `SKILL.md`, so another team can ask *"which deployments can answer this rule
   right now, within this lag budget?"* without adopting our rules, our
   simulation, or our opinions about risk.

## What the verdict tells the agent to do

```
low          the agent signs on its own
medium       escalate to on-device human confirmation (Ledger)
high         refuse
unavailable  refuse — the evidence was unobtainable, which is not the same as safe
```

Built for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026), "Building
from Scratch" track.

---

## Scope, stated plainly

`presign` is an **advisor, not a co-signer**. It never holds keys, never broadcasts,
and never stands in the path of funds. Co-signing would give stronger lock-in and
moves the project into custodial territory with the legal consequences that follow;
that is a deliberate trade, not an oversight.

## Architecture

```
agent -> [x402 / Hedera] -> gateway
                              |- decode unsigned calldata
                              |- fork simulation -> state diff
                              |- operational layer -> live deployments
                              |- rules R1-R4 over the diff
                              '- verdict + reasons + provenance
                                     |
   low -> agent signs   ·   medium -> Ledger   ·   high -> refuse + HCS
```

### Layer 1 — the operational layer over indexed data

Subgraph *discovery* is not rebuilt here; `subgraph-registry` already crawls the
Graph Network meta-subgraph and classifies thousands of subgraphs. Its reliability
score, however, is an economic one (query fees, curation, allocation) — it measures
*"popular and staked"*, not *"indexing right now"*. Four things are layered on top:

- **conformance by query** — introspection plus a probe request, recording which
  fields a deployment actually answers, not a schema hash;
- **liveness and freshness** — `_meta { block hasIndexingErrors }` against chain
  head, expressed as lag in seconds;
- **capability binding to rules** — the query is not "what is this subgraph" but
  "which deployments can answer R3 right now under an N-second lag budget";
- **warm-up** — candidates are resolved ahead of time and kept warm so a verdict
  fits inside a second.

### Layer 2 — the verdict

Simulation does the load-bearing work: running the transaction against a fork
produces the real state diff, and rules read the diff rather than guessing from
calldata.

| Rule | What it catches |
|---|---|
| **R1** Unlimited approval | `approve` for `type(uint256).max` to a spender outside the allowlist, cross-checked against an incident registry |
| **R2** Mutable logic | Contract behind a proxy with a live admin or no timelock |
| **R3** Invariant breach | Shares not reconciling with assets; TVL diverging from issued shares |
| **R4** Unidentified counterparty | No deployment in the registry indexes the contract, and code first appeared at the address N days ago |

R4 is the one rule whose finding is an *absence*. The other three look for
something specific and are honestly silent when they do not find it — which
means a call to a contract deployed this morning that nobody has ever indexed
used to come back `low`, three rules having each found nothing. That is the
same fail-open the `unavailable` tier exists to prevent, arriving by a
different route, and it silently passed the exact case this project is for.

The claim R4 makes is narrow enough to check: not "this contract is unknown",
which is unfalsifiable, but "no deployment in *this* registry indexes *this*
address", which anyone can query. With no verified ABI there is only a 4-byte
selector, and a familiar one proves nothing — matching `approve(address,uint256)`
costs an attacker nothing and is what makes a malicious clone look ordinary.

Age is searched for, not looked up: no RPC returns a contract's birthday, so
one `eth_getCode` at a seven-day horizon answers the question for almost every
counterparty, and a bisection inside that window recovers the exact deployment
block when it matters. R4 also reads EIP-7702 delegations and judges the
delegate rather than the account — without that, every smart account would be
reported as an unidentified contract, and agent wallets are exactly the
accounts that carry delegations.

## Status

This section tracks what is actually running, not what is planned.

| Component | State |
|---|---|
| Repository scaffold | done |
| Secret resolution with declared provenance | done |
| Registry discovery adapter | done |
| Liveness probe (`_meta` vs chain head) | done — verified against live mainnet |
| Conformance probe (introspection + probe query) | done — verified against live mainnet |
| Capability binding + warm cache | done — verified against live mainnet |
| MCP server + `SKILL.md` | done — 7 tools, verified over stdio |
| Fork simulation + rules R1-R3 | done — verified against live mainnet fork |
| R4 unidentified counterparty + EIP-7702 delegation | done — verified against live mainnet |
| Proxy upgrade history over MCP | done — verified against a live stream |
| Ledger DMK escalation, Key Ring source | done — both verified on a Nano X |
| x402 inbound (Hedera) + HCS journal | done — real paid request on testnet |
| x402 outbound (The Graph on Base) | not started |

Measured against live mainnet on 2026-09-05: liveness 173 ms, conformance
394 ms, warming R3 across six lending candidates 611 ms, cached resolve
sub-millisecond.

**Coverage.** Of 18 mainnet lending deployments the registry ranks, 5 answer
the Messari `markets` fields R3 reads — Aave V2, Aave V3, Compound V2,
Compound V3 and Morpho Blue — with no per-protocol code. That is the coverage
lever: one rule, one schema family, every protocol that speaks it.

### What `npm run demo` prints

Four scenarios against a live mainnet fork. The last two are the pair from the
top of this README, shown here in context:

| Scenario | Verdict |
|---|---|
| Unlimited USDC approval to a registry-flagged spender | `high` — do not sign |
| Bounded approval to the same upgradeable token | `medium` — confirm on device |
| Call to Aave V3 Pool, healthy, fresh data | `low` — source named, 12.3 s lag |
| Same call, 1-second freshness budget | `unavailable` — do not sign |

The first row never reaches the device: a transaction already judged dangerous
is refused rather than shown to a human, because a prompt is a request and
people approve prompts. `npm run demo -- --device` runs the second row against a
real Ledger.

## Repository layout

```
packages/operational-layer   freshness, conformance, capability binding
packages/verdict-engine      simulation, rules R1-R4, tiered verdict
packages/gateway             composes verdict, escalation and confirmation
packages/ledger              on-device confirmation, Key Ring secret source
packages/hedera              verdict journal on the Consensus Service
packages/service             x402-gated verdict service
packages/agent               an agent that buys a verdict before signing
packages/demo                runnable end-to-end demonstration
packages/mcp-server          MCP surface + SKILL.md for other agents
packages/secrets             credential resolution with declared provenance
docs/feedback/               per-partner tooling feedback, written as we go
docs/setup/                  device and environment runbooks
```

### Running it

```bash
npm install
npm run demo              # four scenarios against a live mainnet fork
npm run demo -- --device  # medium tier escalates to a real Ledger
```

Needs a Subgraph Studio API key at
`~/.presign/secrets/the-graph__studio-api-key` (mode `0600`), or
`THE_GRAPH_STUDIO_API_KEY` in the environment, plus Foundry for the fork.

### Using the data layer without the rest

The operational layer ships as an MCP server so another team can consume
freshness-gated data selection without adopting our rules, our simulation, or
our opinions about what is risky:

```bash
claude mcp add presign -- npx -y @presign/mcp-server
```

See [`packages/mcp-server/SKILL.md`](./packages/mcp-server/SKILL.md).

## Development

Requires Node 22 (`.nvmrc`) and Foundry for the simulation layer.

```bash
npm install
npm run build
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
