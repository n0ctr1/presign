---
name: presign-data-freshness
description: Decide whether indexed protocol data is fresh enough to act on before signing a transaction. Answers "which deployments can serve this rule right now, and how stale is each one". Use when selecting a subgraph deployment to read protocol state from, when a decision depends on data being current, or when you need to justify a risk verdict with data provenance. Not a transaction scanner and not a signer.
---

# Freshness-gated data selection

## What this is for

Picking a subgraph deployment by popularity and querying it is fine for a
dashboard. It is not fine when the answer decides whether a transaction gets
signed, because **a deployment can be highly ranked and hours behind chain
head**, and nothing in a normal query tells you which.

This server answers the question that matters in that situation: *which
deployments can answer the fields I need, right now, within a freshness budget
I choose* — and it reports how stale each one is so you can defend the answer
afterwards.

## The one rule that matters

**An unsatisfied result means unavailable. It never means safe.**

If `satisfied` is `false`, you do not have fresh protocol context. Report that
you could not evaluate. Do not fall back to a cached answer, do not proceed
because nothing looked wrong, and do not downgrade the concern because the
query "worked". A green judgement reached without fresh context is the failure
mode this whole tool exists to prevent.

## Tools

### `resolve_rule_capability` — start here

```json
{ "rule_id": "R3", "schema_family": "lending-cdp", "network": "mainnet" }
```

Returns deployments that answer every required field and sit inside the
freshness budget, ordered freshest first. Each carries `lag_seconds`,
`effective_lag_seconds`, `blocks_behind`, `has_indexing_errors`,
`answers_fields`, and both a keyed and an x402 query URL.

Read `effective_lag_seconds`, not `lag_seconds`. The first includes the age of
the measurement itself; the second is only what was observed at probe time. A
record measured four minutes ago at 5 s lag is not 5 s fresh, and only the
effective figure says so.

Pass `max_lag_seconds` to tighten or loosen the budget. Pass `refresh: true`
to force re-probing rather than answering from warm cache — do this when a
previous answer looked stale, not routinely, because probing costs gateway
quota.

When `satisfied` is `false`, `reason` tells you where the problem is:

| Reason | What to do |
|---|---|
| `no_candidates` | Nothing indexes this family on this network. Different network, or unsupported. |
| `no_conforming_deployment` | Candidates exist but none answer every field. The schema, not the indexer. |
| `all_candidates_erroring` | Deployments report indexing errors. Wait and retry. |
| `all_candidates_stale` | Everything is past the budget. Either wait, or widen the budget deliberately and say that you did. |

### `identify_protocol_by_contract`

```json
{ "address": "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "network": "mainnet" }
```

Which indexed protocols claim a contract address. Use this **first** when you
have a transaction counterparty and do not yet know what it is: the result
tells you which schema family to then resolve a rule against.

`identified: false` is a real answer, not an error. It means no indexed
protocol claims this address, which for a contract a transaction is about to
touch is itself a risk signal worth reporting.

### `check_deployment_freshness`

Lag for one specific deployment, when you already know which one you care
about. `blocks_behind` and `lag_seconds` are separate on purpose: if the chain
itself stalls, data ages while the indexer sits exactly at head, so
`lag_seconds` grows while `blocks_behind` stays at zero. Do not collapse them
into one judgement.

### `check_deployment_conformance`

Which of the fields you name a deployment actually answers, verified by
executing a probe query rather than reading the schema — a field can be
declared and still fail at execution.

### `list_rule_requirements`

The catalogue: rules, families, fields, default budgets.

## Choosing a freshness budget

The default is 30 s, roughly two Ethereum blocks. Tighter and honest
deployments fail on ordinary gateway jitter. Looser and the data predates the
state the transaction is about to land in.

If you widen the budget, say so in your output alongside the number. A budget
chosen for convenience and not reported is indistinguishable from no budget.

## Reporting

Whatever you conclude, name the deployment ids you used and their effective
lag. That is the difference between "the protocol looks healthy" and "the
protocol looked healthy according to deployment `Qm…` which was 4 seconds
behind head at 12:31:07Z". Only the second can be checked by anyone else.

## What this does not do

It does not simulate transactions, decode calldata, score addresses, detect
exploits or sign anything. It selects and grades data sources. Whatever rules
you run on top of the data are yours.

## Setup

```bash
claude mcp add presign -- npx -y @presign/mcp-server
```

Needs a Subgraph Studio API key, resolved in this order:

1. `~/.presign/secrets/the-graph__studio-api-key`, mode `0600`
2. `THE_GRAPH_STUDIO_API_KEY` in the environment

Free tier is 100k queries/month. Probing costs roughly three queries per
deployment, so prefer warm-cache reads and use `refresh: true` deliberately.
