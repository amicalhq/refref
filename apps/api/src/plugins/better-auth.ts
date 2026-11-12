import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { getAuth } from "@refref/auth";
import { schema, type DBType } from "@refref/coredb";
import { and, eq } from "drizzle-orm";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: {
      id: string;
      userId: string;
      organizationId: string | null;
      permissions: Record<string, string[]> | null;
      enabled: boolean | null;
      metadata?: {
        organizationId?: string;
        createdBy?: string;
        createdAt?: string;
      };
    };
    organization?: {
      id: string;
      name: string;
      slug: string | null;
      logo: string | null;
      createdAt: Date;
      updatedAt: Date;
    } | null;
  }

  interface FastifyInstance {
    authenticateApiKey: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

/**
 * Better Auth API Key verification plugin for Fastify
 * Uses Better Auth's built-in verifyApiKey function with rate limiting and hashing
 */
const betterAuthPlugin = fp(
  async (fastify: FastifyInstance, opts: { db: DBType }) => {
    // Create Better Auth instance using shared @refref/auth package
    const auth = getAuth({
      baseURL: process.env.APP_URL || "http://localhost:4000",
      resendApiKey: process.env.RESEND_API_KEY || "debug_key",
      db: opts.db,
      schema,
      enabledSocialAuth: [],
      enablePasswordAuth: false,
      enableMagicLinkAuth: false,
    });

    if (!fastify.hasRequestDecorator("apiKey")) {
      fastify.decorateRequest("apiKey", undefined);
    }

    // Create a reusable authentication hook
    fastify.decorate(
      "authenticateApiKey",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const apiKeyHeader = request.headers["x-api-key"] as string | undefined;

        if (!apiKeyHeader) {
          return reply.code(401).send({
            error: "Unauthorized",
            message: "API key required. Provide X-Api-Key header.",
          });
        }

        try {
          // First, verify the API key without permissions to get metadata
          const result = await auth.api.verifyApiKey({
            body: {
              key: apiKeyHeader,
            },
          });

          if (!result.valid || !result.key) {
            return reply.code(401).send({
              error: "Unauthorized",
              message: "Invalid API key",
            });
          }

          const apiKeyData = result.key;

          // Check if the API key is enabled
          if (!apiKeyData.enabled) {
            return reply.code(401).send({
              error: "Unauthorized",
              message: "API key is disabled",
            });
          }

          // Extract organizationId from API key metadata
          const metadata = apiKeyData.metadata;
          const organizationId = metadata?.organizationId;

          if (typeof organizationId !== "string" || !organizationId) {
            return reply.code(500).send({
              error: "Internal Server Error",
              message: "API key is missing organization context",
            });
          }

          // Validate that the API key has the required permissions for this organization
          const permissions = apiKeyData.permissions;

          if (
            !permissions ||
            !permissions[organizationId] ||
            !Array.isArray(permissions[organizationId]) ||
            !permissions[organizationId].includes("full_access")
          ) {
            return reply.code(403).send({
              error: "Forbidden",
              message:
                "API key does not have permissions for this organization",
            });
          }

          // Metadata is caller-provided; bind access to the organization's service account.
          const [owner] = await opts.db
            .select({ id: schema.user.id })
            .from(schema.orgUser)
            .innerJoin(schema.user, eq(schema.orgUser.userId, schema.user.id))
            .where(
              and(
                eq(schema.orgUser.orgId, organizationId),
                eq(schema.user.id, apiKeyData.referenceId),
                eq(schema.user.role, "service"),
              ),
            )
            .limit(1);

          if (!owner) {
            return reply.code(403).send({
              error: "Forbidden",
              message:
                "API key does not belong to the organization's service account",
            });
          }

          // Fetch organization for authorization context
          const orgData = await opts.db.query.org.findFirst({
            where: (org, { eq }) => eq(org.id, organizationId),
          });

          if (!orgData) {
            return reply.code(404).send({
              error: "Not Found",
              message: "Organization not found",
            });
          }

          // Attach API key info and context to request
          request.apiKey = {
            id: apiKeyData.id,
            userId: apiKeyData.referenceId,
            organizationId,
            permissions,
            enabled: apiKeyData.enabled,
            metadata: metadata,
          };

          // Attach organization to request for route handlers
          request.organization = orgData;
        } catch (error) {
          request.log.error({ error }, "API key verification error");
          return reply.code(401).send({
            error: "Unauthorized",
            message: "Invalid API key",
          });
        }
      },
    );
  },
  {
    name: "better-auth-plugin",
    dependencies: ["coredb-plugin"], // Ensure coredb is loaded first
  },
);

export default betterAuthPlugin;
