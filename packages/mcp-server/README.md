# @presign/mcp-server

MCP server answering: **which indexed deployments can serve this risk rule
right now, and how stale is each one.**

```bash
claude mcp add presign -- npx -y @presign/mcp-server
```

See [SKILL.md](./SKILL.md) for the agent-facing instructions.

## Why this ships separately

The verdict engine is opinionated — it has views about what is risky, how to
simulate, which rules to run. Freshness-gated data selection is not. Any team
whose decision depends on protocol state being current needs the same thing
and should not have to adopt our opinions to get it.

So this server is consumable on its own. It selects and grades data sources
and stops there. It does not simulate transactions, decode calldata, score
addresses or sign anything.

## Tools

| Tool | Answers |
|---|---|
| `resolve_rule_capability` | Which deployments serve a rule now, within a lag budget |
| `identify_protocol_by_contract` | Which indexed protocols claim a contract address |
| `check_deployment_freshness` | Lag from chain head for one deployment |
| `check_deployment_conformance` | Which named fields a deployment actually answers |
| `list_rule_requirements` | Rules, families, fields, default budgets |

## The contract that matters

**Unsatisfied means unavailable, never safe.** Every unsatisfied response
carries that instruction inline, because the failure mode being defended
against is a caller reading "no data returned" as "no problem found".

Responses report both `lag_seconds` (observed at probe time) and
`effective_lag_seconds` (observed lag plus the age of the measurement). Budgets
are enforced against the second. A record measured four minutes ago at five
seconds of lag is not a five-second-fresh record, and a server that reported
only the first number would be handing callers a stale answer that looks fresh.

## Measured

Against live mainnet, `R3` / `lending-cdp`:

```
cold resolve (discover + probe 20 candidates)   1707 ms
warm resolve (cache read)                          1 ms
deployments returned                                 6
```

Warming happens on first call, so a caller is never told `not_warmed` for a
rule they are entitled to ask about.

## Configuration

Studio API key, resolved strongest-first:

1. `~/.presign/secrets/the-graph__studio-api-key`, mode `0600`
2. `THE_GRAPH_STUDIO_API_KEY`

Chain head comes from public RPC endpoints carrying no credentials. That is
deliberate: chain head must be obtainable independently of the indexer, so it
should not share a failure domain with anything we authenticate to.

`maxCandidates` defaults to 20 here rather than the library's 8. On mainnet
lending, all five deployments that answer `R3` rank *below* five that do not,
so a narrow probe window returns almost nothing while good candidates sit just
outside it.
