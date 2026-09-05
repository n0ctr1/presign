/**
 * Secret resolution with declared provenance.
 *
 * The same reasoning that drives verdict provenance drives this module. A
 * verdict that does not say how fresh its data was is not checkable; a service
 * that does not say where its credentials came from is not auditable either.
 * Every resolution therefore carries the source that answered it, and that
 * label is meant to be surfaced, not just logged.
 */

/**
 * Identifies a secret independently of where it is stored, so that moving a
 * credential from a file to hardware-backed storage changes configuration
 * rather than call sites.
 */
export interface SecretRef {
  /** Owning system, e.g. `the-graph`. */
  readonly scope: string;
  /** Secret within that scope, e.g. `studio-api-key`. */
  readonly name: string;
}

/**
 * How well a source protects the secret it returned.
 *
 * This is a security property, not a preference. `hardware` means the secret
 * is sealed by a device and decrypted per use; `process` means it is readable
 * by anything that can read this process's memory, environment or filesystem.
 * The distinction is what lets an operator answer "could this key have leaked"
 * without reading the deployment scripts.
 */
export type SecretProtection = "hardware" | "process";

/** A resolved secret together with the record of who answered. */
export interface ResolvedSecret {
  readonly ref: SecretRef;
  readonly value: string;
  /** Name of the source that answered, e.g. `ledger-key-ring`. */
  readonly source: string;
  readonly protection: SecretProtection;
  readonly resolvedAt: Date;
}

/**
 * A place secrets can come from.
 *
 * Kept behind an interface because the production path (a Ledger Key Ring,
 * which needs a physically attached device) cannot run in CI or on a machine
 * with no USB access, while the code that consumes secrets must be identical
 * in both places.
 */
export interface SecretSource {
  readonly name: string;
  readonly protection: SecretProtection;
  /** Resolve the secret, or return null if this source does not hold it. */
  get(ref: SecretRef): Promise<string | null>;
}

/** Raised when no source in the chain holds the requested secret. */
export class SecretNotFoundError extends Error {
  readonly ref: SecretRef;
  readonly tried: readonly string[];

  constructor(ref: SecretRef, tried: readonly string[]) {
    super(
      `no source holds ${ref.scope}/${ref.name} (tried: ${tried.join(", ") || "none"})`,
    );
    this.name = "SecretNotFoundError";
    this.ref = ref;
    this.tried = tried;
  }
}

/**
 * Raised when a secret resolved, but from a source weaker than the caller
 * required.
 *
 * Separate from {@link SecretNotFoundError} on purpose: "the key is missing"
 * and "the key is present but sitting in an environment variable in
 * production" need different operator responses, and collapsing them into one
 * error is how the second one gets ignored.
 */
export class InsufficientProtectionError extends Error {
  readonly ref: SecretRef;
  readonly got: SecretProtection;
  readonly required: SecretProtection;

  constructor(
    ref: SecretRef,
    got: SecretProtection,
    required: SecretProtection,
  ) {
    super(
      `${ref.scope}/${ref.name} resolved from a ${got}-protected source but ${required} protection is required`,
    );
    this.name = "InsufficientProtectionError";
    this.ref = ref;
    this.got = got;
    this.required = required;
  }
}
