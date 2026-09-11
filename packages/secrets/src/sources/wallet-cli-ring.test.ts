import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FileSecretSource,
  ringFileName,
  ringKeyName,
  SecretResolver,
  WalletCliRingSource,
} from "../../dist/index.js";

const REF = { scope: "hedera", name: "testnet-agent-key" };

/**
 * A stand-in for `wallet-cli` that "decrypts" by rot13 and checks it was asked
 * for the right key. The real binary needs a provisioned Key Ring, which needs
 * a device; what is under test here is everything around the call.
 */
async function fakeCli(body: string): Promise<{ dir: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), "presign-ring-"));
  const binary = join(dir, "wallet-cli");
  await writeFile(binary, `#!/bin/sh\n${body}\n`);
  await chmod(binary, 0o755);
  return { dir, binary };
}

const ROT13_CLI = `
[ "$1" = ring ] && [ "$2" = decrypt ] || exit 2
if [ "$4" != "${ringKeyName(REF)}" ]; then
  echo '{"ok":false,"error":{"message":"Decryption failed for key '"$4"'"}}' >&2
  exit 1
fi
tr 'a-z' 'n-za-m' < "$6"`;

test("names the ring key and the file after the secret", () => {
  assert.equal(ringKeyName(REF), "presign:hedera:testnet-agent-key");
  assert.equal(ringFileName(REF), "hedera__testnet-agent-key.enc");
});

test("no ciphertext file means not this source's secret, and the CLI is never run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-ring-"));
  const source = new WalletCliRingSource({ directory: dir, binary: join(dir, "does-not-exist") });

  assert.equal(await source.get(REF), null);
});

test("decrypts through wallet-cli ring with the key derived from the ref", async () => {
  const { dir, binary } = await fakeCli(ROT13_CLI);
  await writeFile(join(dir, ringFileName(REF)), "frperg-xrl\n");

  const source = new WalletCliRingSource({ directory: dir, binary });

  assert.equal(await source.get(REF), "secret-key");
  assert.equal(source.protection, "hardware-rooted");
});

test("a refusal surfaces the CLI's own message and never falls through to plaintext", async () => {
  const { dir, binary } = await fakeCli(ROT13_CLI);
  const other = { scope: "hedera", name: "testnet-service-key" };
  await writeFile(join(dir, ringFileName(other)), "nnnn");
  // A plaintext copy sits right beside it, which is exactly the file a
  // silent fall-through would have used.
  await writeFile(join(dir, "hedera__testnet-service-key"), "plaintext", { mode: 0o600 });

  const resolver = new SecretResolver([
    new WalletCliRingSource({ directory: dir, binary }),
    new FileSecretSource(dir),
  ]);

  await assert.rejects(resolver.resolve(other), /Decryption failed for key presign:hedera:testnet-service-key/);
});

test("a ring waiting for a password it was never given times out with a pointer", async () => {
  const { dir, binary } = await fakeCli("sleep 5");
  await writeFile(join(dir, ringFileName(REF)), "x");

  const source = new WalletCliRingSource({ directory: dir, binary, timeoutMs: 200 });

  await assert.rejects(source.get(REF), /WALLET_PASS/);
});

test("a missing binary says how to install it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-ring-"));
  await writeFile(join(dir, ringFileName(REF)), "x");

  const source = new WalletCliRingSource({ directory: dir, binary: join(dir, "absent") });

  await assert.rejects(source.get(REF), /@ledgerhq\/wallet-cli/);
});
