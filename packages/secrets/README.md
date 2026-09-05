# @presign/secrets

Secret resolution that declares **where the credential came from**.

The same reasoning that drives verdict provenance drives this package. A
verdict that does not say how fresh its data was is not checkable. A service
that does not say where its credentials came from is not auditable either.

## Why this is not just `process.env`

The Ledger track asks for concrete use of Ledger primitives rather than wallet
branding, and names *"agents that use secrets they cannot leak"* explicitly.
Holding the Subgraph Studio key in a Ledger Key Ring instead of a `.env` file
is that requirement, met directly: one touch at enrolment, headless decryption
afterwards, and the key never exists in plaintext on disk.

`SecretProtection` encodes the distinction as a type:

| Protection | Meaning |
|---|---|
| `hardware` | Sealed by a device, decrypted per use |
| `process` | Readable by anything that can read this process's env, memory or filesystem |

Environment variables are `process` by definition — they are inherited by every
child process, appear in crash dumps and process listings, and get captured
wholesale by error reporters. Setting `minimumProtection: "hardware"` makes a
deployment that would have quietly fallen back to an env var **fail at
startup** instead. That is what turns the guarantee from a claim in a README
into something the process enforces.

## Chain order is the guarantee

Sources are tried in order and the first that holds the secret wins, so a
hardware source belongs ahead of any file. Reversed, a forgotten development
file silently shadows the device and the deployment looks fine while running on
a key that leaked months ago.

```ts
const resolver = new SecretResolver(
  [ledgerKeyRing, new FileSecretSource("~/.presign/secrets")],
  { minimumProtection: "hardware" },   // production
);

const { value, source, protection } = await resolver.resolve({
  scope: "the-graph",
  name: "studio-api-key",
});
```

`SecretNotFoundError` and `InsufficientProtectionError` are deliberately
separate. "The key is missing" and "the key is present but sitting in an
environment variable in production" need different operator responses, and
collapsing them into one error is how the second gets ignored.

## Sources

| Source | Protection | Use |
|---|---|---|
| `LedgerKeyRingSource` | `hardware` | Production. **Not yet implemented** — requires an attached device; lands day 6 with the rest of the Ledger work. |
| `FileSecretSource` | `process` | Developer machines. Refuses to read a file that is group- or world-readable. |
| `EnvSecretSource` | `process` | CI only. |

`FileSecretSource` expects one file per secret, named `<scope>__<name>`, mode
`0600`:

```bash
mkdir -p ~/.presign/secrets && chmod 700 ~/.presign/secrets
printf '%s' "$KEY" > ~/.presign/secrets/the-graph__studio-api-key
chmod 600 ~/.presign/secrets/the-graph__studio-api-key
```

It strips trailing whitespace, because a key carrying the newline a shell
redirect left behind fails authentication in a way that reads like a bad key.

## Ledger package names

For the record, since the obvious guesses are wrong: there is no
`@ledgerhq/key-ring-cli` or `@ledgerhq/keyring-cli` on npm. The real packages
are `@ledgerhq/ledger-key-ring-protocol` (0.15.2), its hardware layer
`@ledgerhq/hw-ledger-key-ring-protocol` (0.10.7), and the DMK trusted-app kit
`@ledgerhq/device-trusted-app-kit-ledger-keyring-protocol` (0.5.0).
