/**
 * Establishes which fields a deployment actually answers.
 *
 * Conformance is checked in two steps, and both are needed. Introspection says
 * what the schema *declares*; a probe query says what the deployment *answers*.
 * They disagree in practice: a field can be declared and still fail at
 * execution because the entity was never populated or a nested resolver
 * errors. Only the second check is evidence a rule can rely on.
 */

import { GatewayQueryError, type GatewayClient } from "../gateway/client.js";
import type {
  ConformanceChecker,
  ConformanceReport,
  DeploymentId,
  FieldRequirement,
} from "../types.js";

/**
 * Walks the query type once to find `rootField` and unwrap its type.
 *
 * A list field arrives as `NON_NULL(LIST(NON_NULL(Market)))`, so the named type
 * sits up to four wrappers deep; the nesting below covers that.
 */
/**
 * A GraphQL field name, checked because these are interpolated into a query.
 *
 * The data-layer MCP server takes the root field and the field list from a
 * model, and a "field" carrying braces would rewrite the document it lands in
 * and spend an operator's gateway quota on whatever it asked for instead.
 */
const GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertGraphQLNames(names: readonly string[]): void {
  const bad = names.filter((name) => !GRAPHQL_NAME.test(name));
  if (bad.length > 0) {
    throw new TypeError(`not GraphQL field names: ${bad.join(", ")}`);
  }
}

const QUERY_TYPE_INTROSPECTION = `{
  __schema {
    queryType {
      fields {
        name
        type {
          kind name
          ofType { kind name ofType { kind name ofType { kind name } } }
        }
      }
    }
  }
}`;

interface TypeRef {
  kind?: unknown;
  name?: unknown;
  ofType?: TypeRef | null;
}

interface QueryTypeResponse {
  __schema?: {
    queryType?: { fields?: readonly { name?: unknown; type?: TypeRef }[] | null } | null;
  } | null;
}

interface EntityTypeResponse {
  __type?: { fields?: readonly { name?: unknown }[] | null } | null;
}

/** Unwrap NON_NULL and LIST wrappers down to the named type. */
function namedType(ref: TypeRef | undefined | null): string | null {
  let cursor: TypeRef | undefined | null = ref;
  while (cursor) {
    if (typeof cursor.name === "string" && cursor.name.length > 0) {
      return cursor.name;
    }
    cursor = cursor.ofType;
  }
  return null;
}

export class ConformanceProbe implements ConformanceChecker {
  readonly #gateway: GatewayClient;
  readonly #now: () => Date;

  constructor(options: { gateway: GatewayClient; now?: () => Date }) {
    this.#gateway = options.gateway;
    this.#now = options.now ?? (() => new Date());
  }

  async check(
    deploymentId: DeploymentId,
    requirement: FieldRequirement,
  ): Promise<ConformanceReport> {
    const declared = await this.#declaredFields(deploymentId, requirement.rootField);

    // Fields the schema does not declare cannot go into a probe query: GraphQL
    // rejects the whole document for one unknown field, which would report
    // every field as missing because of a single absent one.
    const candidates = requirement.fields.filter((field) => declared.has(field));
    const answered = await this.#answeredFields(
      deploymentId,
      requirement.rootField,
      candidates,
    );

    return {
      deploymentId,
      answersFields: requirement.fields.filter((field) => answered.has(field)),
      missingFields: requirement.fields.filter((field) => !answered.has(field)),
      checkedAt: this.#now(),
    };
  }

  /** Field names declared on the entity behind `rootField`. */
  async #declaredFields(
    deploymentId: DeploymentId,
    rootField: string,
  ): Promise<ReadonlySet<string>> {
    const schema = await this.#gateway.query<QueryTypeResponse>(
      deploymentId,
      QUERY_TYPE_INTROSPECTION,
    );

    const queryFields = schema.__schema?.queryType?.fields ?? [];
    const match = queryFields.find((field) => field.name === rootField);
    if (match === undefined) return new Set();

    const entityType = namedType(match.type);
    if (entityType === null) return new Set();

    const entity = await this.#gateway.query<EntityTypeResponse>(
      deploymentId,
      `query EntityFields($name: String!) { __type(name: $name) { fields { name } } }`,
      { name: entityType },
    );

    const names = new Set<string>();
    for (const field of entity.__type?.fields ?? []) {
      if (typeof field.name === "string") names.add(field.name);
    }
    return names;
  }

  /**
   * Ask for the fields for real.
   *
   * `first: 1` keeps the probe cheap — the Studio free tier is 100k queries a
   * month and warming hundreds of deployments burns it fast. On failure each
   * field is retried alone, so one broken resolver costs its own field rather
   * than the whole set.
   */
  async #answeredFields(
    deploymentId: DeploymentId,
    rootField: string,
    fields: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (fields.length === 0) return new Set();
    assertGraphQLNames([rootField, ...fields]);

    try {
      await this.#gateway.query(
        deploymentId,
        `{ ${rootField}(first: 1) { ${fields.join(" ")} } }`,
      );
      return new Set(fields);
    } catch (error) {
      if (!(error instanceof GatewayQueryError) || fields.length === 1) {
        return new Set();
      }
    }

    const answered = new Set<string>();
    const results = await Promise.all(
      fields.map(async (field) => {
        try {
          await this.#gateway.query(
            deploymentId,
            `{ ${rootField}(first: 1) { ${field} } }`,
          );
          return field;
        } catch {
          return null;
        }
      }),
    );
    for (const field of results) {
      if (field !== null) answered.add(field);
    }
    return answered;
  }
}
