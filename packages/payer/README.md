# @presign/payer

Pays for presign verdicts over x402 on Hedera.

- `resolveKey(raw, accountId, network)` — reads a key in any form the Hedera
  portal offers and accepts it only if its public key matches what the account
  holds on the mirror node. A raw ED25519 key is no longer misread as ECDSA.
- `createPayer({ accountId, privateKey, network, sessionBudgetTinybars })` — a
  `fetch` that pays on 402, with a per-payment ceiling and an optional budget
  for the whole session. The budget is checked against the price in the 402
  manifest **before** anything is signed, and an unreadable price is refused.

Shared by `@presign/agent` and `@presign/verdict-mcp`.
