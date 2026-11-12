import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fp from "fastify-plugin";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@refref/coredb";
import { getAuth } from "@refref/auth";
import betterAuthPlugin from "../../src/plugins/better-auth.js";

vi.unmock("@refref/coredb");

const databaseUrl = process.env.API_AUTH_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL API key authorization", () => {
  const url = new URL(
    databaseUrl ?? "postgresql://postgres@localhost/refref_auth_test",
  );
  if (
    url.pathname !== "/refref_auth_test" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  ) {
    throw new Error(
      "API_AUTH_TEST_DATABASE_URL must name a local refref_auth_test database",
    );
  }
  const client = postgres(url.toString(), { max: 1 });
  const db = drizzle(client, { schema });
  const auth = getAuth({
    baseURL: "http://localhost:3000",
    db,
    schema,
    resendApiKey: "debug_key",
    enabledSocialAuth: [],
    enablePasswordAuth: false,
    enableMagicLinkAuth: false,
  });
  const app = Fastify();
  const users = [randomUUID(), randomUUID()];
  const organizations = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    await db
      .insert(schema.org)
      .values(organizations.map((id) => ({ id, name: id, slug: id })));
    await db
      .insert(schema.user)
      .values(
        users.map((id, index) => ({
          id,
          name: id,
          email: `${id}@example.com`,
          emailVerified: true,
          role: index === 0 ? "service" : "member",
        })),
      );
    await db
      .insert(schema.orgUser)
      .values(
        users.map((userId) => ({
          userId,
          orgId: organizations[0]!,
          role: "member",
        })),
      );
    await app.register(fp(async () => {}, { name: "coredb-plugin" }));
    await app.register(betterAuthPlugin, { db });
    app.get(
      "/protected",
      { preHandler: app.authenticateApiKey },
      async (request) => ({
        userId: request.apiKey?.userId,
        organizationId: request.organization?.id,
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await db.delete(schema.org).where(inArray(schema.org.id, organizations));
    await db.delete(schema.user).where(inArray(schema.user.id, users));
    await client.end();
  });

  async function createKey(owner: string, organizationId: string) {
    return auth.api.createApiKey({
      body: {
        name: "PostgreSQL Authorization Test",
        userId: owner,
        permissions: { [organizationId]: ["full_access"] },
        metadata: { organizationId },
      },
    });
  }

  it("accepts the organization's actual service-account key", async () => {
    const key = await createKey(users[0]!, organizations[0]!);
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": key.key },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: users[0],
      organizationId: organizations[0],
    });
  });

  it("rejects a service account claiming another organization", async () => {
    const key = await createKey(users[0]!, organizations[1]!);
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": key.key },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects an ordinary member even when the organization has a service account", async () => {
    const key = await createKey(users[1]!, organizations[0]!);
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": key.key },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects malformed persisted permission strings", async () => {
    const key = await createKey(users[0]!, organizations[0]!);
    await db
      .update(schema.apikey)
      .set({
        permissions: JSON.stringify({ [organizations[0]!]: "no_full_access" }),
      })
      .where(eq(schema.apikey.id, key.id));
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": key.key },
    });
    expect(response.statusCode).toBe(403);
  });
});
