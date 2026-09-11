import assert from "node:assert/strict";
import { test } from "node:test";

import { PrivateKey } from "@hashgraph/sdk";

import { resolveOperatorKey } from "../dist/index.js";

/** A mirror node reporting a chosen key type and public key for any account. */
const mirror = (type: string, key: string) =>
  (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ key: { _type: type, key } }),
  })) as unknown as typeof globalThis.fetch;

test("a raw hex operator key is read as the type the account holds", async () => {
  const ed = PrivateKey.generateED25519();
  const ec = PrivateKey.generateECDSA();

  // The case that used to go wrong: raw ED25519 hex parsed as a different,
  // valid ECDSA key, and every journal write failed with INVALID_SIGNATURE.
  const fromEd = await resolveOperatorKey(ed.toStringRaw(), "0.0.1", "testnet", mirror("ED25519", ed.publicKey.toStringRaw()));
  assert.equal(fromEd.publicKey.toStringRaw(), ed.publicKey.toStringRaw());

  const fromEc = await resolveOperatorKey(`0x${ec.toStringRaw()}`, "0.0.1", "testnet", mirror("ECDSA_SECP256K1", ec.publicKey.toStringRaw()));
  assert.equal(fromEc.publicKey.toStringRaw(), ec.publicKey.toStringRaw());
});

test("a DER key names its own type and needs no mirror node", async () => {
  const ed = PrivateKey.generateED25519();
  const unreachable = (() => Promise.reject(new Error("offline"))) as unknown as typeof globalThis.fetch;

  const key = await resolveOperatorKey(ed.toStringDer(), "0.0.1", "testnet", unreachable);
  assert.equal(key.publicKey.toStringRaw(), ed.publicKey.toStringRaw());
});

test("raw hex is refused rather than guessed when the account cannot be asked", async () => {
  const unreachable = (() => Promise.reject(new Error("offline"))) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    resolveOperatorKey(PrivateKey.generateECDSA().toStringRaw(), "0.0.1", "testnet", unreachable),
    /DER form/,
  );
});

test("a key from another account is refused by name", async () => {
  const theirs = PrivateKey.generateECDSA();
  await assert.rejects(
    resolveOperatorKey(PrivateKey.generateECDSA().toStringRaw(), "0.0.42", "testnet", mirror("ECDSA_SECP256K1", theirs.publicKey.toStringRaw())),
    /not the one account 0\.0\.42 holds/,
  );
});
