/**
 * GraphQL client for The Graph's gateway.
 *
 * Two behaviours of the gateway shape this code:
 *
 * 1. It answers HTTP 200 with a GraphQL error body when authentication is
 *    missing or wrong. Checking the status code alone reports a broken key as a
 *    successful empty result, which on a fail-closed path is the difference
 *    between refusing to answer and answering "nothing looks wrong".
 * 2. Queries are addressed either by subgraph id or by deployment id. This
 *    client uses deployment ids, because a subgraph id floats to whatever
 *    version the owner publishes next and provenance has to name the
 *    deployment that actually answered.
 */

import type { DeploymentId } from "../types.js";

const DEFAULT_BASE_URL = "https://gateway.thegraph.com/api";

/** Every query is bounded: a verdict has a latency budget it cannot exceed. */
const DEFAULT_TIMEOUT_MS = 3_000;

export interface GatewayClientOptions {
  /** Resolves the Studio API key per call, so a rotated key is picked up. */
  readonly apiKey: () => Promise<string>;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Raised when the gateway declines or fails a query. */
export class GatewayQueryError extends Error {
  readonly deploymentId: DeploymentId;
  readonly httpStatus: number | null;
  readonly graphqlErrors: readonly string[];

  constructor(
    deploymentId: DeploymentId,
    message: string,
    details: { httpStatus?: number | null; graphqlErrors?: readonly string[] } = {},
  ) {
    super(`gateway query for ${deploymentId} failed: ${message}`);
    this.name = "GatewayQueryError";
    this.deploymentId = deploymentId;
    this.httpStatus = details.httpStatus ?? null;
    this.graphqlErrors = details.graphqlErrors ?? [];
  }
}

interface GraphQLBody {
  data?: unknown;
  errors?: unknown;
}

function readGraphQLErrors(body: GraphQLBody): readonly string[] {
  if (!Array.isArray(body.errors)) return [];
  return body.errors.map((entry) => {
    if (typeof entry === "object" && entry !== null) {
      const message = (entry as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return JSON.stringify(entry);
  });
}

export class GatewayClient {
  readonly #apiKey: () => Promise<string>;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GatewayClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Endpoint pinned to one immutable deployment. */
  deploymentUrl(deploymentId: DeploymentId): string {
    return `${this.#baseUrl}/deployments/id/${deploymentId}`;
  }

  async query<T>(
    deploymentId: DeploymentId,
    query: string,
    variables?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const key = await this.#apiKey();

    let response: Response;
    try {
      response = await this.#fetch(this.deploymentUrl(deploymentId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(
          variables === undefined ? { query } : { query, variables },
        ),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      // A timeout is a freshness failure like any other: the caller must fail
      // closed rather than wait past its budget.
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new GatewayQueryError(deploymentId, reason, { httpStatus: null });
    }

    let body: GraphQLBody;
    try {
      body = (await response.json()) as GraphQLBody;
    } catch {
      throw new GatewayQueryError(deploymentId, "response was not JSON", {
        httpStatus: response.status,
      });
    }

    // Checked before the status code, because the gateway reports auth failures
    // as HTTP 200 with an error body.
    const errors = readGraphQLErrors(body);
    if (errors.length > 0) {
      throw new GatewayQueryError(deploymentId, errors.join("; "), {
        httpStatus: response.status,
        graphqlErrors: errors,
      });
    }

    if (!response.ok) {
      throw new GatewayQueryError(deploymentId, `HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }

    if (body.data === undefined || body.data === null) {
      throw new GatewayQueryError(deploymentId, "response carried no data", {
        httpStatus: response.status,
      });
    }

    return body.data as T;
  }
}
