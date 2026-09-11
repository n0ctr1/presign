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
| **R1** Unlimited approval | An unlimited allowance written in the state diff to a spender outside the allowlist; an allowance of *any* amount to an address on [ScamSniffer's open blacklist](https://github.com/scamsniffer/scam-database), fetched at startup and every six hours, is critical |
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
| x402 inbound (Hedera) + HCS journal | done — real paid request on testnet, settled through Blocky402 |
| Chain guard | done — a transaction for a chain the fork does not hold is refused before payment |
| Incident registry for R1 | done — ScamSniffer's open blacklist, loaded live and shown on `/health` |
| R3 pool resolution through the factory | done — Uniswap V3 pools and V2 pairs verified against live mainnet |
| Key broker on `wallet-cli ring` | done — verified on a Nano X: the verdict MCP paid for a real verdict with a key decrypted from the Key Ring, with no key in any file or environment variable |
| x402 outbound (The Graph on Base) | done — real paid queries settled on Base, verified on-chain |

### Measured

Component timings against live mainnet: liveness 173 ms, conformance 394 ms,
warming R3 across six lending candidates 611 ms, cached resolve
sub-millisecond. Those are parts, and the sum of parts is not a latency claim,
so `npm run latency` times whole verdicts instead:

| counterparty | cold | warm p50 | what it pays for |
|---|---|---|---|
| Aave V3 Pool | 701 ms | 79 ms | R3 discovers, probes and queries |
| USDC | 394 ms | 8 ms | R1, R2, and a counterparty R3 cannot speak for |
| freshly deployed contract | 952 ms | 5 ms | R4 bisects historical `eth_getCode` |
| Uniswap V3 USDC/WETH pool | 1196 ms | 99 ms | R3 resolves the pool through its factory and reads it by id |
| Uniswap V3 Factory | 3006 ms | 3008 ms | the slow end — see below |

Cold is the first verdict for that counterparty; warm is the repeats after it.
The one-second budget holds everywhere except the last row, and that row is
kept in deliberately. R3's query for the factory asks for the largest pools by
value locked, and the Uniswap V3 subgraph does not answer that inside the
three-second gateway timeout, so the verdict is `unavailable`. Raising
the limit to accommodate it cost a cold USDC verdict 306 ms → 7.7 s, because a
slow deployment indexing USDC then spends most of the budget before R3 gives
up on it. The short limit wins and the trade-off is a caller-settable
`timeoutMs`, because it is a latency preference and not a safety one.

### False positives

A scanner that marks ordinary contracts as dangerous is worse than one with
narrow coverage — the first thing anyone does with a verdict they distrust is
ignore it. `npm run safety` runs the rules over twelve mainnet contracts
nobody disputes:

```
low: 10   medium: 1   unavailable: 1
```

None reaches `high`. The single `medium` is USDC, whose proxy admin is a plain
EOA — saying so is correct, not a false positive. Running this is what found
the one real false positive there was: R4 charged a human confirmation for
Permit2, Multicall3 and Uniswap's router, on the reasoning that a contract old
enough to be known and still unindexed was a coverage gap. That reasoning was
wrong. Indexing tracks whether a contract emits events worth querying, not
whether it can be trusted, so immutable utility contracts are systematically
unindexed. The finding is still reported; it no longer moves the tier.

### Coverage

`npm run coverage` sweeps every schema family the rules read against every
network the engine maps:

| schema family | mainnet | optimism | matic | base | arbitrum |
|---|---|---|---|---|---|
| lending-cdp | 6 | 3 | 3 | 4 | 6 |
| dex-amm | 2 | 2 | 1 | 1 | 2 |
| yield-vault | 2 | 0 | 0 | 0 | 1 |

**33 conforming deployments across 3 schema families and 5 networks** — Aave
V2/V3, Compound V2/V3, Morpho Blue, DForce, Sonne, Radiant, Seamless, Curve,
Uniswap V3, Velodrome V2, Sushiswap, Yearn V2, Rari — reachable by the same
rules with no per-protocol code. Nothing has to be added for a new protocol
inside a family that is already read; it is covered the moment somebody
indexes it with the standard schema. What costs a line is a new family, and
the three rows above are what those three lines bought.

Pools needed one more step. DEX subgraphs index pools through templates, so a
manifest names the factory and never the pool, and asking the registry which
deployments index a pool's address finds almost nothing. For the Uniswap V3
USDC/WETH pool it found two deployments that do not speak the schema and one
whose only indexer was down, and R3 answered `unavailable` — correctly, since a
conforming deployment might have been behind the failure, and one was. R3 now
asks the pool for its `factory()`, has the factory confirm the pool through
`getPool` or `getPair` at the pool's own tokens, and reads that one pool by id
from the deployments indexing the factory. The confirmation is what keeps an
impostor from borrowing Uniswap's standing by returning its factory address.
The same code serves Uniswap V2 pairs.

### What `npm run demo` prints

Five scenarios against a live mainnet fork. The middle pair is the one from
the top of this README, shown here in context:

| Scenario | Verdict |
|---|---|
| Unlimited USDC approval to an address on ScamSniffer's blacklist | `high` — do not sign |
| Bounded approval to Permit2 on the same upgradeable token | `medium` — confirm on device |
| Call to Aave V3 Pool, healthy, fresh data | `low` — source named, 12.3 s lag |
| Same call, 1-second freshness budget | `unavailable` — do not sign |
| Contract deployed minutes ago, indexed by nobody | `high` — do not sign |

The last row uses no fixed address. The demo walks back from the fork block
until it finds a real contract created minutes earlier, because any address
written down here would be a week old by the next run. R1, R2 and R3 are all
silent on it, and before R4 existed those three silences added up to `low`.

The first row never reaches the device: a transaction already judged dangerous
is refused rather than shown to a human, because a prompt is a request and
people approve prompts. `npm run demo -- --device` runs the second row against a
real Ledger.

## What a verdict costs

The service charges for a verdict and the verdict costs something to produce.
`npm run demo -- --paid` shows both against one transaction, in one process,
with nothing mocked:

```
  IN  — the agent paid us, on Hedera
        0.005 HBAR   0.0.10399265 -> 0.0.10398276
        0.0.9185802@1788837451.614028743

  OUT — we paid The Graph, on Base
        0.01 USDC  QmcXE5QVcBcv…  0xf1928bbe4cf4d666a31c4e9f6a2bf3704c77ec9bd717b43a7fe3e79dd99f2e5d
        1 queries, 0.01 USDC in total
```

That run settled through x402.org's facilitator, which is the `0.0.9185802`
fee payer above. The service has since moved to Blocky402's testnet
facilitator; a settlement from it, checkable on the mirror node, is
`0.0.7162784@1789089549.242890259` — 0.001 HBAR from the agent to the service,
the network fee paid by Blocky402's account.

Split across two terminals those are two anecdotes. Printed together against
one transaction they are a margin, and both settlements are public: the HBAR
on Hedera testnet, the USDC on Base. The verdict is journalled to HCS in the
same run, carrying the transaction hash, the tier, and the deployment that
answered with its lag — and no calldata, address or value.

Both halves are in the response body too:

```json
"cost": {
  "charged": "0.005 HBAR",
  "paid_upstream": {
    "funding": "x402",
    "queries_paid": 2,
    "total": "0.02 USDC",
    "payments": [{ "deployment_id": "Qm…", "amount": "0.01 USDC", "transaction": "0x…" }]
  }
}
```

Queries to The Graph can be funded two ways. A Studio API key draws on a
monthly plan: the per-query cost is real but arrives as a bill, and nothing in
the response says what it was — so on that path `paid_upstream` reports
`known: false` rather than a zero it would be inventing. The x402 path pays
$0.01 USDC per query on Base, and the amount is read from the gateway's own
402 manifest, recorded only once settlement returns, with the settlement hash
attached.

The transfer is EIP-3009 `transferWithAuthorization`, so a payment is a
signature the facilitator submits. The wallet needs USDC and no ETH, and this
process never broadcasts a transaction — which is the same claim the advisor
makes about signing.

A Studio key wins whenever one exists, because spending real money should be
deliberate; `GATEWAY_FUNDING=x402` forces payment. The case worth pointing at
is the third one: **no key and a funded wallet**, where the process pays its
own way. That is not a fallback but the reason x402 exists, in The Graph's own
words — *you have a funded wallet and no API key, and no human to mint one*.

Payments are sent **one at a time**. The gateway refuses concurrent payments
from the same payer — four in flight returned two answers and two bare 402s —
and the rule that needs indexed data probes every candidate deployment in
parallel, because that is free when a key funds the queries. Without
serialising, the paid path lost a probe or two per verdict at random and
fail-closed logic correctly refused to answer, with a funded wallet and
correct code. A verdict a second slower is still a verdict; one assembled
from whichever probes won a race is not.

**Verified with real money.** `npm run demo` on the paid path returns `low`
for the Aave call with its deployment and lag named, and `unavailable` for the
same call at a 1-second budget — the project's central claim, produced
entirely from data bought a cent at a time. A settlement picked from that run
resolves on Base: 0.01 USDC from the payer to the `payTo` in the gateway's own
manifest, gas paid by the facilitator rather than by us.

## Repository layout

```
packages/operational-layer   freshness, conformance, capability binding
packages/verdict-engine      simulation, rules R1-R4, tiered verdict
packages/gateway             composes verdict, escalation and confirmation
packages/ledger              on-device confirmation, Key Ring secret source
packages/hedera              verdict journal on the Consensus Service
packages/service             x402-gated verdict service
packages/payer               pays for verdicts over x402, key checks, session budget
packages/verdict-mcp         lets a model buy a verdict as an MCP tool
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
npm run demo              # five scenarios against a live mainnet fork
npm run demo -- --device  # medium tier escalates to a real Ledger
npm run demo -- --paid    # real money both ways, one transaction, two chains
```

Every number claimed above is a command, not a screenshot:

```bash
npm run latency           # whole verdicts timed, cold and warm apart
npm run safety            # the rules over twelve undisputed mainnet contracts
npm run coverage          # conforming deployments per schema family per network
```

`npm run safety` exits non-zero if anything reaches `high`, so it can gate a
release rather than be read and shrugged at.

Needs a Subgraph Studio API key at
`~/.presign/secrets/the-graph__studio-api-key` (mode `0600`), or
`THE_GRAPH_STUDIO_API_KEY` in the environment, plus Foundry for the fork.

To pay per query instead, put a Base private key at
`~/.presign/secrets/base__payer-key` (mode `0600`) or `BASE_PAYER_KEY`, and
fund that address with USDC on Base. No ETH is needed: payments are EIP-3009
authorisations, submitted by the facilitator. With a payer key and no Studio
key, the process pays automatically.

### Letting a model buy the verdict

Any agent that speaks HTTP and x402 can already buy a verdict. A model in an
MCP client cannot: it has tools, not a payment client, so somebody had to write
the x402 exchange before it could ask. `@presign/verdict-mcp` is that exchange,
packaged as a tool.

```bash
claude mcp add presign-verdict \
  -e HEDERA_TESTNET_AGENT_ID=0.0.XXXXXXX \
  -e HEDERA_TESTNET_AGENT_KEY=<private key as the portal shows it> \
  -- node "$PWD/packages/verdict-mcp/dist/bin.js"
```

`get_quote` and `check_service` are free; `get_verdict` pays over x402 on Hedera
and returns the tier with `what_to_do` attached. The model spends from a session
budget it cannot raise, checked against the price in the 402 manifest **before**
anything is signed — a paid tool invoked in a loop otherwise empties a wallet a
cent at a time. Verified against the live service: a model bought a verdict over
stdio for 0.005 HBAR, settled on Hedera, and a 0.004 HBAR budget refused the
next one with nothing paid.

It is kept separate from the data-layer server below on purpose: that one is
built to be used without presign's rules, and paid verdicts inside it would
dissolve exactly that separation.

Neither MCP server is published to npm; both commands assume a clone with
`npm install && npm run build` done, run from the repository root.

### Using the data layer without the rest

The operational layer ships as an MCP server so another team can consume
freshness-gated data selection without adopting our rules, our simulation, or
our opinions about what is risky:

```bash
claude mcp add presign -- node "$PWD/packages/mcp-server/dist/bin.js"
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
