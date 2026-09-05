import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Tests import the built entry point rather than the sources: it exercises the
// package exactly as a consumer sees it, and keeps the NodeNext ".js"
// specifiers in src/ working under Node's type stripping.
import {
  EnvSecretSource,
  envVarName,
  FileSecretSource,
  InsecureFilePermissionsError,
  InsufficientProtectionError,
  SecretNotFoundError,
  SecretResolver,
  type SecretRef,
  type SecretSource,
} from "../dist/index.js";

const STUDIO_KEY: SecretRef = { scope: "the-graph", name: "studio-api-key" };

/** Stand-in for the Ledger Key Ring, which needs an attached device. */
function hardwareSource(value: string | null): SecretSource {
  return {
    name: "ledger-key-ring",
    protection: "hardware",
    get: () => Promise.resolve(value),
  };
}

test("derives the conventional env var name", () => {
  assert.equal(envVarName(STUDIO_KEY), "THE_GRAPH_STUDIO_API_KEY");
});

test("reports which source answered, not just the value", async () => {
  const resolver = new SecretResolver([
    new EnvSecretSource({ THE_GRAPH_STUDIO_API_KEY: "from-env" }),
  ]);

  const resolved = await resolver.resolve(STUDIO_KEY);

  assert.equal(resolved.value, "from-env");
  assert.equal(resolved.source, "env");
  assert.equal(resolved.protection, "process");
});

test("prefers the hardware source over a leftover development fallback", async () => {
  const resolver = new SecretResolver([
    hardwareSource("from-device"),
    new EnvSecretSource({ THE_GRAPH_STUDIO_API_KEY: "stale-dev-key" }),
  ]);

  const resolved = await resolver.resolve(STUDIO_KEY);

  // Ordering is the whole guarantee: a forgotten env var must not shadow the
  // device once the device is present.
  assert.equal(resolved.value, "from-device");
  assert.equal(resolved.source, "ledger-key-ring");
});

test("falls through a hardware source that does not hold the secret", async () => {
  const resolver = new SecretResolver([
    hardwareSource(null),
    new EnvSecretSource({ THE_GRAPH_STUDIO_API_KEY: "from-env" }),
  ]);

  assert.equal((await resolver.resolve(STUDIO_KEY)).source, "env");
});

test("refuses a process-protected secret when hardware protection is required", async () => {
  const resolver = new SecretResolver(
    [new EnvSecretSource({ THE_GRAPH_STUDIO_API_KEY: "from-env" })],
    { minimumProtection: "hardware" },
  );

  // Production must fail at startup rather than quietly running on an env var.
  await assert.rejects(
    () => resolver.resolve(STUDIO_KEY),
    (error: unknown) => {
      assert.ok(error instanceof InsufficientProtectionError);
      assert.equal(error.got, "process");
      assert.equal(error.required, "hardware");
      return true;
    },
  );
});

test("names every source it tried when nothing holds the secret", async () => {
  const resolver = new SecretResolver([
    hardwareSource(null),
    new EnvSecretSource({}),
  ]);

  await assert.rejects(
    () => resolver.resolve(STUDIO_KEY),
    (error: unknown) => {
      assert.ok(error instanceof SecretNotFoundError);
      assert.deepEqual(error.tried, ["ledger-key-ring", "env"]);
      return true;
    },
  );
});

test("reads a 0600 secret file and strips the shell's trailing newline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-secrets-"));
  const path = join(dir, "the-graph__studio-api-key");
  await writeFile(path, "key-from-file\n");
  await chmod(path, 0o600);

  const resolved = await new SecretResolver([new FileSecretSource(dir)]).resolve(
    STUDIO_KEY,
  );

  assert.equal(resolved.value, "key-from-file");
  assert.equal(resolved.source, "file");
});

test("refuses a group- or world-readable secret file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-secrets-"));
  const path = join(dir, "the-graph__studio-api-key");
  await writeFile(path, "leaky");
  await chmod(path, 0o644);

  await assert.rejects(
    () => new FileSecretSource(dir).get(STUDIO_KEY),
    InsecureFilePermissionsError,
  );
});

test("treats an absent file as 'not held' rather than an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "presign-secrets-"));
  assert.equal(await new FileSecretSource(dir).get(STUDIO_KEY), null);
});
