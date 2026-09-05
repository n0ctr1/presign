# @presign/operational-layer

Liveness, freshness and capability binding on top of subgraph discovery.

Discovery is a solved problem — [`subgraph-registry`](https://github.com/PaulieB14/subgraph-registry)
already crawls the Graph Network meta-subgraph, classifies 15k+ subgraphs by
domain and protocol type, and extracts contract addresses from every manifest.
This package does **not** rebuild any of that. It answers a different question.

## The question discovery does not answer

A registry ranks deployments by a **reliability score** built from on-chain
economic signals — query fees (30%), 30-day volume (30%), curation (20%) and
indexer allocation (20%). That is an excellent measure of *"popular and staked"*.
It is not a measure of *"indexing right now"*.

There is no `_meta` in that score, no distance from chain head, no
`hasIndexingErrors`, and the corpus re-syncs on a multi-day cadence. A
deployment can hold a high reliability score while sitting six hours behind
chain head. For a dashboard that is a footnote. For a verdict returned
immediately before a signature it is the whole risk.

## What this layer adds

**Conformance by query.** An upstream schema fingerprint (MD5 over
`entity:field_count` pairs) detects that a schema changed and groups forks. It
cannot tell you whether a deployment will answer the specific fields your rule
reads. So we introspect `__schema`, send a probe query, and record the field
list — conformance is a set, not a boolean.

**Liveness and freshness.** `_meta { block { number } hasIndexingErrors }`
compared against chain head from an independent RPC source, expressed as lag in
seconds. RPC and the indexer are kept behind separate interfaces on purpose:
losing chain head must not be indistinguishable from losing the indexer.

**Capability binding to rules.** The query this layer answers is not "what is
this subgraph" but *"which deployments can answer R3 right now, under a
30-second lag budget"*. A resolution is either satisfied with records or
unsatisfied with a reason — there is no third state, so a caller cannot
accidentally read an empty list as "fine".

**Warm-up.** A verdict has to fit inside a second, so candidates are probed
ahead of time and held warm. Resolution at request time is a cache read.

## Source is a parameter

`DiscoverySource` and `ChainHeadSource` are interfaces. The Graph is the first
implementation because the track requires it, but the Hosted Service is
deprecated and the ecosystem is spreading across Ormi, Goldsky, Envio and
SubQuery. Going indexer-agnostic should be a new implementation of an
interface, not a rewrite of this layer.

## Record shape

```
schema_family:   lending-cdp
protocol:        aave-v3
network:         mainnet
deployment_id:   Qm…
answers_fields:  [totalValueLockedUSD, totalBorrowBalanceUSD, …]
lag_seconds:     14
indexing_errors: false
checked_at:      2026-09-04T12:00:00Z
```

This record is what gets quoted verbatim in a verdict's provenance block. That
is the point: the caller can see which deployments a green verdict rests on and
how stale each one was.

## Resolving a rule

Probing happens ahead of time; resolution at request time is a **synchronous
cache read**. That split is not an optimisation — introspection, a probe query
and a chain-head lookup per candidate cannot happen while a signature waits.

```ts
const index = new CapabilityIndex({ discovery, conformance, liveness });

await index.warm(R3, "mainnet");            // slow path, off the request
const resolution = index.resolve(R3, "mainnet");   // sync, sub-millisecond

if (!resolution.satisfied) {
  // fail closed: `unavailable`, never `safe`
  return unavailable(resolution.reason);
}
```

### Cached freshness is aged, not trusted

A record probed five minutes ago reporting five seconds of lag is **not** a
five-second-fresh record. The deployment may have kept up, but nothing proves
it did, so the age of the measurement is added back:

```
effective lag = measured lag + (now - checkedAt)
```

Without this, a warm cache quietly converts stale data into green verdicts —
the exact failure this project exists to prevent, arriving through our own
cache rather than through the indexer.

### Rejection reasons are ordered by blocker

`resolve` never returns an empty success. It returns one of:

| Reason | Means |
|---|---|
| `not_warmed` | The index has never been warmed for this rule. Operator error. |
| `no_candidates` | Discovery returned nothing for this family on this network. |
| `no_conforming_deployment` | Candidates exist, none answer every field the rule reads. |
| `all_candidates_erroring` | Conforming deployments exist, all report indexing errors. |
| `all_candidates_stale` | Conforming deployments exist, all past the freshness budget. |

The distinction is operational: someone told *"all stale"* goes to the
indexer, someone told *"nothing conforms"* goes to the schema. Reporting the
wrong one sends them to the wrong system.

### Ordering never uses reliability

Satisfied results are ordered by effective lag, then by field coverage.
Reliability is deliberately **not** a tiebreak: it is an economic score that
tracks traction and therefore age, and letting it order a freshness-gated list
reintroduces exactly the bias this layer exists to remove.

## Status

Verified end to end against live mainnet on 2026-09-05. Warming R3 across six
lending candidates took 611 ms; the cached resolve that follows is
sub-millisecond. The `Status` table in the [root README](../../README.md)
tracks the project as a whole.
