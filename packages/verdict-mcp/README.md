# @presign/verdict-mcp

Lets a model buy a pre-signature verdict over MCP.

Not published to npm. From a clone, at the repository root:

```bash
npm install && npm run build
claude mcp add presign-verdict \
  -e HEDERA_TESTNET_AGENT_ID=0.0.XXXXXXX \
  -e HEDERA_TESTNET_AGENT_KEY=<private key as the portal shows it> \
  -- node "$PWD/packages/verdict-mcp/dist/bin.js"
```

The id and key can also live in `~/.presign/secrets/hedera__testnet-agent-id`
and `hedera__testnet-agent-key` instead of the environment.

Tools:

| tool | cost | answers |
|---|---|---|
| `get_quote` | free | prices and which rules each route runs |
| `check_service` | free | which rules run and whether data sources are live |
| `get_verdict` | 0.001–0.005 HBAR | tier, findings, provenance with source lag, what to do |

The model pays over x402 on Hedera, inside a session budget it cannot raise
(`PRESIGN_SESSION_BUDGET_HBAR`, default 0.1) with a ceiling on any single payment
(`PRESIGN_MAX_PER_PAYMENT_HBAR`, default 0.05). The budget is checked against the
price in the 402 manifest before anything is signed.

Kept separate from `@presign/mcp-server`, which is the data layer and is designed
to be used without presign's rules. See [SKILL.md](./SKILL.md) for the
instructions a model follows.
