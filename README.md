# presign

**Pre-flight transaction risk advisor for agentic wallets.**

An autonomous agent holding a key will sign whatever its planner hands it. `presign`
sits in front of that signature: the agent submits the *unsigned* transaction, and
gets back a machine-readable verdict — a risk tier, the rules that fired, and the
**provenance of the data the verdict was made from**.

```
low     -> the agent signs on its own
medium  -> escalate to on-device confirmation (Ledger)
high    -> refuse, and write the justification to Hedera Consensus Service
```

Built for [ETHOnline 2026](https://ethglobal.com/events/ethonline2026), "Building from Scratch" track.

---

## Why another risk API

Pre-signature simulation is not new — Hexagate, Blockaid and GoPlus all do it, and
the agent-facing packaging (MCP servers, LangChain tools, pay-per-call x402
endpoints) is already shipped by incumbents. Speed of integration is no longer a
differentiator, and this repo does not claim it as one.

What none of them return is **how fresh the data behind the verdict was**. A green
verdict computed from a subgraph that is six hours behind chain head looks exactly
like a green verdict computed from chain head. On a dashboard that is a footnote.
Immediately before a signature it is the entire risk.

`presign` makes three things load-bearing:

1. **Data lag is declared in the response.** Every verdict names the deployments it
   was computed from and how many seconds behind chain head each one was.
2. **Fail-closed on stale context.** If the counterparty is identified as a pool or
   market of a known protocol and fresh data for it is unavailable or lagging past
   budget, the answer is `unavailable` — never `safe`. A green verdict is
   physically unreachable without fresh context.
3. **The data layer ships separately.** The operational layer is exposed as an MCP
   server and a `SKILL.md`, so another team can ask *"which deployments can answer
   this rule right now, within this lag budget?"* without touching our engine.

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
                              |- rules R1-R3 over the diff
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

`unknown contract` is an explicit verdict class, not a bug: with no verified ABI
there is only a 4-byte selector, and the honest answer is *"call not recognised,
contract deployed N days ago, risk high"*.

## Status

Day 1 of 9. This section tracks what is actually running, not what is planned.

| Component | State |
|---|---|
| Repository scaffold | done |
| Secret resolution with declared provenance | done |
| Registry discovery adapter | done |
| Liveness probe (`_meta` vs chain head) | done — verified against live mainnet |
| Conformance probe (introspection + probe query) | done — verified against live mainnet |
| Capability binding + warm cache | done — verified against live mainnet |
| MCP server + `SKILL.md` | done — 5 tools, verified over stdio |
| Fork simulation + rules R1-R3 | done — verified against live mainnet fork |
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

### The guarantee, demonstrated

Four scenarios against a live mainnet fork. Only the last two differ, and only
in the freshness budget:

| Scenario | Verdict |
|---|---|
| Unlimited USDC approval to a registry-flagged spender | `high` — do not sign |
| Bounded approval to the same upgradeable token | `medium` — confirm on device |
| Call to Aave V3 Pool, healthy, fresh data | `low` — source named, 12.3 s lag |
| Same call, 1-second freshness budget | `unavailable` — do not sign |

The last row is the point. Same protocol, same data, same code path: when fresh
context cannot be obtained the answer is `unavailable`, and `unavailable` is
structurally distinct from `low`.

## Repository layout

```
packages/operational-layer   freshness, conformance, capability binding
packages/verdict-engine      simulation, rules R1-R3, tiered verdict
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
