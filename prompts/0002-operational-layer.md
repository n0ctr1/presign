# 0002 — The operational layer over indexed data

Spawn `subgraph-registry` as an MCP subprocess and treat its output as
*candidates only*. Never inherit its reliability score into a verdict.

For each candidate deployment:

- **Conformance by query.** Introspect `__schema`, then issue a real query for
  the fields a rule needs. Conformance is not boolean — record the list of
  fields the deployment actually answers.
- **Liveness.** Query `_meta { block { number timestamp } hasIndexingErrors }`
  and compare against an independently obtained chain head. Express lag in
  seconds.
- **Capability binding.** The layer's query is not "what subgraph is this" but
  "which deployments can answer requirement X on chain Y right now with lag
  under N seconds".
- **Warming.** Selection happens ahead of time and resolves from cache at
  request time; a verdict has a one-second budget.

Record shape: schema family, protocol, chain, deployment id, answered fields,
lag in seconds, indexing errors, checked-at.

Ship the layer as its own package and as an MCP server with a `SKILL.md`, so
it is useful standalone. Source must be a parameter, not a baked-in
assumption — the first refactor after the hackathon should make it
indexer-agnostic.
