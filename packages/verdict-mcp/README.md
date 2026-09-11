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

## Keep the paying key on a Ledger Key Ring

This server is a broker: the model gets `get_verdict` inside a budget it cannot
raise, and never the key that pays for it. With the key sealed by the
[Ledger Key Ring CLI](https://developers.ledger.com/docs/ai-tools/ledger-cli),
it is not in a file, an MCP config or a shell history either. The server looks
for `~/.presign/ring/hedera__testnet-agent-key.enc` before any file or
environment variable, and a ring that refuses to decrypt stops startup rather
than falling back to a plaintext copy.

Once, with the device connected and the Ledger Sync app installed:

```bash
npm i -g @ledgerhq/wallet-cli
wallet-cli ring init       # asks for the ring password; store it in your OS keychain
mkdir -p ~/.presign/ring
read -rs KEY && printf %s "$KEY" | \
  WALLET_PASS=$(secret-tool lookup service ledger-wallet-cli account default) \
  wallet-cli ring encrypt --key presign:hedera:testnet-agent-key \
    -o ~/.presign/ring/hedera__testnet-agent-key.enc; unset KEY
```

After that no device is needed. Register the server so the password is read
from the keychain at launch rather than written into the MCP config:

```bash
claude mcp add presign-verdict \
  -e HEDERA_TESTNET_AGENT_ID=0.0.XXXXXXX \
  -- sh -c 'WALLET_PASS=$(secret-tool lookup service ledger-wallet-cli account default) \
            exec node "'"$PWD"'/packages/verdict-mcp/dist/bin.js"'
```

On start it says where the key came from:

```
presign-verdict-mcp: hedera testnet-agent-key from ledger-key-ring (wallet-cli ring) (hardware-rooted)
```

`hardware-rooted`, not `hardware`: the ciphertext is useless off this machine
and removing the machine from the ring ends decryption, but decrypting uses the
ring membership stored here rather than a touch on the device. The key is in
this process's memory while it signs payments, as any signing key must be.

## Signing policy for `sign_transaction`

With an Ethereum key at `~/.presign/ring/ethereum__agent-key.enc`, the server
also signs — only through a verdict, and only within a policy set here, not by
the model:

| variable | default | effect |
|---|---|---|
| `PRESIGN_BROKER_ALLOW` | empty | comma-separated recipients value may reach without a human |
| `PRESIGN_BROKER_MAX_ETH_PER_TX` | `0.01` | ETH above this in one transaction needs a human |
| `PRESIGN_BROKER_MAX_ETH_PER_SESSION` | `0.05` | ETH past this across the session is refused |
| `PRESIGN_BROKER_MAX_FEE_ETH` | `0.005` | `gas × maxFeePerGas` past this is refused |
| `PRESIGN_BROKER_MAX_PRIORITY_GWEI` | `3` | a priority fee past this is refused |
| `PRESIGN_LEDGER` | unset | `1` attaches the device that approves `medium` |

"Needs a human" means the verdict is treated as `medium`: the Ledger must sign
the same call first, and without a device nothing is signed. With the defaults
every transfer to anyone is approved on the device, which is the safe place to
start; widen the allowlist for recipients the agent pays routinely.

Tools:

| tool | cost | answers |
|---|---|---|
| `get_quote` | free | prices and which rules each route runs |
| `check_service` | free | which rules run and whether data sources are live |
| `get_verdict` | 0.001–0.009 HBAR, metered by the indexed data it checks | tier, findings, provenance with source lag, what to do |

The model pays over x402 on Hedera, inside a session budget it cannot raise
(`PRESIGN_SESSION_BUDGET_HBAR`, default 0.1) with a ceiling on any single payment
(`PRESIGN_MAX_PER_PAYMENT_HBAR`, default 0.05). The budget is checked against the
price in the 402 manifest before anything is signed.

Kept separate from `@presign/mcp-server`, which is the data layer and is designed
to be used without presign's rules. See [SKILL.md](./SKILL.md) for the
instructions a model follows.
