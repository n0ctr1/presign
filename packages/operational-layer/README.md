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

## Status

Day 1 of 9 — core types are in place; probes and the capability index are
landing next. This README describes the intended contract, and the `Status`
table in the [root README](../../README.md) tracks what actually runs.
