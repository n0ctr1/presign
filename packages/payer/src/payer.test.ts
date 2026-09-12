import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BudgetExceededError,
  createPayer,
  formatTinybars,
  hbarToTinybars,
  parseHederaNetwork,
  PrivateKey,
  resolveKey,
} from "../dist/index.js";

test("HBAR amounts convert without floating point", () => {
  assert.equal(hbarToTinybars("0.005"), 500_000n);
  assert.equal(hbarToTinybars("0.1"), 10_000_000n);
  assert.equal(hbarToTinybars("1"), 100_000_000n);
  assert.equal(formatTinybars(500_000n), "0.005 HBAR");
  assert.equal(formatTinybars(100_000_000n), "1 HBAR");
  assert.throws(() => hbarToTinybars("0.000000001"), RangeError);
  assert.throws(() => hbarToTinybars("abc"), RangeError);
});

test("the network is read from the environment or refused, never guessed", () => {
  assert.deepEqual(parseHederaNetwork(undefined), { network: "hedera:testnet", short: "testnet" });
  assert.deepEqual(parseHederaNetwork(" hedera:mainnet "), { network: "hedera:mainnet", short: "mainnet" });

  // "mainnet" without the prefix used to be cast: testnet secrets, a mainnet
  // x402 network, and a facilitator that did not exist several frames later.
  assert.throws(() => parseHederaNetwork("mainnet"), RangeError);
  assert.throws(() => parseHederaNetwork("eip155:1"), RangeError);
});

/** A mirror node that reports a chosen key type and public key. */
const mirror = (type: string | undefined, key: string | undefined) =>
  (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ key: { _type: type, key } }),
  })) as unknown as typeof globalThis.fetch;

test("every portal key format resolves to the key the account holds", async () => {
  const ec = PrivateKey.generateECDSA();
  const ed = PrivateKey.generateED25519();
  const ecAccount = mirror("ECDSA_SECP256K1", ec.publicKey.toStringRaw());
  const edAccount = mirror("ED25519", ed.publicKey.toStringRaw());

  for (const [raw, account, want] of [
    [ec.toStringRaw(), ecAccount, ec],
    ["0x" + ec.toStringRaw(), ecAccount, ec],
    [ec.toStringDer(), ecAccount, ec],
    [ed.toStringDer(), edAccount, ed],
    // The case that used to go wrong silently: raw ED25519 hex was read as
    // ECDSA and became a different, valid-looking key.
    [ed.toStringRaw(), edAccount, ed],
  ] as const) {
    const key = await resolveKey(raw, "0.0.1", "hedera:testnet", account);
    assert.equal(key.publicKey.toStringRaw(), want.publicKey.toStringRaw());
  }
});

test("a key from another account is refused by name, not by bytes", async () => {
  const mine = PrivateKey.generateECDSA();
  const theirs = PrivateKey.generateECDSA();
  await assert.rejects(
    () => resolveKey(mine.toStringRaw(), "0.0.42", "hedera:testnet",
      mirror("ECDSA_SECP256K1", theirs.publicKey.toStringRaw())),
    /not the one account 0\.0\.42 holds/,
  );
});

test("something that is not a private key says so", async () => {
  const account = mirror("ECDSA_SECP256K1", PrivateKey.generateECDSA().publicKey.toStringRaw());
  for (const raw of ["0.0.1234567", "", "a".repeat(63)]) {
    await assert.rejects(() => resolveKey(raw, "0.0.1", "hedera:testnet", account), /does not contain a private key/);
  }
});

/** A Hedera x402 manifest asking for a given number of tinybars. */
const manifest = (amount: string) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://presign.test/verdict/full" },
      accepts: [
        {
          scheme: "exact",
          network: "hedera:testnet",
          amount,
          asset: "0.0.0",
          payTo: "0.0.10398276",
          maxTimeoutSeconds: 300,
          extra: { feePayer: "0.0.9185802" },
        },
      ],
    }),
  ).toString("base64");

test("a payment that would exceed the session budget is refused before it is signed", async () => {
  let signedAttempts = 0;
  const gateway = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.headers.get("payment-signature") !== null) signedAttempts += 1;
    return new Response(null, { status: 402, headers: { "payment-required": manifest("500000") } });
  }) as unknown as typeof globalThis.fetch;

  const payer = createPayer({
    accountId: "0.0.1",
    privateKey: PrivateKey.generateECDSA(),
    network: "hedera:testnet",
    sessionBudgetTinybars: 400_000n,
    fetch: gateway,
  });

  await assert.rejects(
    () => payer.fetch("https://presign.test/verdict/full", { method: "POST" }),
    (error: unknown) => error instanceof BudgetExceededError && error.asked === 500_000n,
  );

  // A model calling a paid tool in a loop is the reason for the budget. The
  // refusal has to happen before a signature exists, or it is not a refusal.
  assert.equal(signedAttempts, 0);
  assert.equal(payer.spent, 0n);
  assert.equal(payer.remaining, 400_000n);
});

test("the budget is checked against the option the client pays, not the first one listed", async () => {
  let signedAttempts = 0;
  const cheapElsewhere = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "https://presign.test/verdict/full" },
      accepts: [
        // Listed first, on a network this payer has no scheme for.
        { scheme: "exact", network: "eip155:8453", amount: "1", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x0000000000000000000000000000000000000001", maxTimeoutSeconds: 300, extra: {} },
        { scheme: "exact", network: "hedera:testnet", amount: "5000000", asset: "0.0.0", payTo: "0.0.10398276", maxTimeoutSeconds: 300, extra: { feePayer: "0.0.7162784" } },
      ],
    }),
  ).toString("base64");
  const gateway = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.headers.get("payment-signature") !== null) signedAttempts += 1;
    return new Response(null, { status: 402, headers: { "payment-required": cheapElsewhere } });
  }) as unknown as typeof globalThis.fetch;

  const payer = createPayer({
    accountId: "0.0.1",
    privateKey: PrivateKey.generateECDSA(),
    network: "hedera:testnet",
    sessionBudgetTinybars: 1_000_000n,
    fetch: gateway,
  });

  // The first entry costs one tinybar and fits; the one that would be paid
  // costs 0.05 HBAR and does not. The second is the one that counts.
  await assert.rejects(
    () => payer.fetch("https://presign.test/verdict/full", { method: "POST" }),
    (error: unknown) => error instanceof BudgetExceededError && error.asked === 5_000_000n,
  );
  assert.equal(signedAttempts, 0);
  assert.equal(payer.spent, 0n);
});

test("with a budget set, an unreadable price is refused rather than paid blind", async () => {
  const gateway = (async () =>
    new Response(null, { status: 402 })) as unknown as typeof globalThis.fetch;

  const payer = createPayer({
    accountId: "0.0.1",
    privateKey: PrivateKey.generateECDSA(),
    network: "hedera:testnet",
    sessionBudgetTinybars: 10_000_000n,
    fetch: gateway,
  });

  await assert.rejects(
    () => payer.fetch("https://presign.test/verdict/full", { method: "POST" }),
    /price could not be read/,
  );
  assert.equal(payer.spent, 0n);
});
