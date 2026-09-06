import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  KeyRingError,
  LedgerKeyRingSecretSource,
  REQUIRED_DEVICE_APP,
  runAuthenticate,
} from "../dist/index.js";
import type { KeyRingProtocol, VaultFile } from "../dist/index.js";

const STUDIO_KEY = { scope: "the-graph", name: "studio-api-key" };
const KEY = new Uint8Array(32).fill(7);

/** Reversible stand-in for the protocol's AES, so round-trips are checkable. */
function xorProtocol(states: readonly Record<string, unknown>[] = []): KeyRingProtocol {
  const xor = (data: Uint8Array) =>
    Promise.resolve(Uint8Array.from(data.map((b, i) => b ^ KEY[i % KEY.length]!)));
  return {
    authenticate: () => ({
      observable: {
        subscribe(handlers: {
          next: (s: Record<string, unknown>) => void;
          error: (e: unknown) => void;
        }) {
          queueMicrotask(() => {
            for (const state of states) handlers.next(state);
          });
          return { unsubscribe() {} };
        },
      },
      cancel() {},
    }),
    encryptData: (_k, data) => xor(data),
    decryptData: (_k, data) => xor(data),
  };
}

const session = {
  trustchainId: "tc-1",
  applicationPath: "m/0'/16'",
  encryptionKey: KEY,
};

const emptyVault: VaultFile = {
  version: 1,
  trustchainId: "tc-1",
  applicationPath: "m/0'/16'",
  secrets: {},
};

const authInput = {
  keyPair: {},
  clientName: "presign",
  permissions: 0xffffffff,
  sessionId: "s",
};

test("a missing trusted app is reported as a missing install, not a bad name", async () => {
  const protocol = xorProtocol([
    { status: "error", error: { errorCode: "6807", message: "Unknown application name" } },
  ]);

  await assert.rejects(
    () => runAuthenticate(protocol, authInput),
    (error: unknown) => {
      assert.ok(error instanceof KeyRingError);
      assert.equal(error.code, "device_app_missing");
      // "Unknown application name" reads as a wrong string rather than an
      // absent app, which is exactly how it was first misread here.
      assert.match(error.message, new RegExp(REQUIRED_DEVICE_APP));
      assert.match(error.message, /Ledger Live/);
      return true;
    },
  );
});

test("a locked device is reported as locked, with the remedy", async () => {
  const protocol = xorProtocol([
    { status: "error", error: { _tag: "DeviceLockedError" } },
  ]);

  await assert.rejects(
    () => runAuthenticate(protocol, authInput),
    (error: unknown) => {
      assert.ok(error instanceof KeyRingError);
      assert.equal(error.code, "device_locked");
      assert.match(error.message, /PIN/);
      return true;
    },
  );
});

test("a completed authentication yields the trustchain and encryption key", async () => {
  const steps: string[] = [];
  const protocol = xorProtocol([
    { status: "pending", intermediateValue: { step: "lkrp.steps.openApp" } },
    { status: "pending", intermediateValue: { step: "lkrp.steps.extractEncryptionKey" } },
    { status: "completed", output: session },
  ]);

  const result = await runAuthenticate(protocol, authInput, {
    onStep: (step) => steps.push(step),
  });

  assert.equal(result.trustchainId, "tc-1");
  assert.equal(result.encryptionKey.length, 32);
  assert.deepEqual(steps, ["lkrp.steps.openApp", "lkrp.steps.extractEncryptionKey"]);
});

test("stores ciphertext and reads the value back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-keyring-"));
  const vaultPath = join(dir, "vault.json");
  const source = LedgerKeyRingSecretSource.fromSession(
    xorProtocol(),
    session,
    vaultPath,
    emptyVault,
  );

  await source.store(STUDIO_KEY, "super-secret-studio-key");

  assert.equal(await source.get(STUDIO_KEY), "super-secret-studio-key");
});

test("the plaintext secret never reaches the disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-keyring-"));
  const vaultPath = join(dir, "vault.json");
  const source = LedgerKeyRingSecretSource.fromSession(
    xorProtocol(),
    session,
    vaultPath,
    emptyVault,
  );

  await source.store(STUDIO_KEY, "super-secret-studio-key");
  const onDisk = await readFile(vaultPath, "utf8");

  // The whole point of the primitive. If this ever fails, the vault is a
  // .env file with extra steps.
  assert.ok(!onDisk.includes("super-secret-studio-key"));
  assert.match(onDisk, /"the-graph\/studio-api-key"/);
});

test("an absent secret is null, so the resolver moves to the next source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-keyring-"));
  const source = LedgerKeyRingSecretSource.fromSession(
    xorProtocol(),
    session,
    join(dir, "vault.json"),
    emptyVault,
  );

  assert.equal(await source.get({ scope: "nope", name: "missing" }), null);
});

test("declares hardware protection", () => {
  const source = LedgerKeyRingSecretSource.fromSession(
    xorProtocol(),
    session,
    "/tmp/unused",
    emptyVault,
  );

  // Honest only because the encryption key is never persisted: an on-disk
  // member key would make this process protection wearing a hardware label.
  assert.equal(source.protection, "hardware");
  assert.equal(source.name, "ledger-key-ring");
});
