/**
 * @presign/secrets
 *
 * Secret resolution that declares where the credential came from, so "could
 * this key have leaked" is answerable from the response rather than from the
 * deployment scripts.
 */

export {
  InsufficientProtectionError,
  SecretNotFoundError,
  type ResolvedSecret,
  type SecretProtection,
  type SecretRef,
  type SecretSource,
} from "./types.js";

export { SecretResolver, type SecretResolverOptions } from "./resolver.js";
export { EnvSecretSource, envVarName } from "./sources/env.js";
export { FileSecretSource, InsecureFilePermissionsError } from "./sources/file.js";
