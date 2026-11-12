import Fastify from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import betterAuthPlugin from "../../src/plugins/better-auth.js";
import type { DBType } from "@refref/coredb";

const { verifyApiKey } = vi.hoisted(() => ({ verifyApiKey: vi.fn() }));
vi.mock("@refref/auth", () => ({ getAuth: () => ({ api: { verifyApiKey } }) }));

describe("Better Auth API key verification response", () => {
  const organization = { id: "org-a", name: "Organization A" };
  let app: ReturnType<typeof Fastify>;
  const serviceAccount = vi.fn();
  const key = {
    id: "key-a",
    referenceId: "service-account-a",
    enabled: true,
    metadata: { organizationId: "org-a" },
    permissions: { "org-a": ["full_access"] },
  };

  beforeEach(async () => {
    verifyApiKey.mockReset();
    serviceAccount.mockResolvedValue([{ id: "service-account-a" }]);
    app = Fastify();
    await app.register(fp(async () => {}, { name: "coredb-plugin" }));
    const db = {
      query: { org: { findFirst: vi.fn().mockResolvedValue(organization) } },
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: serviceAccount,
    };
    await app.register(betterAuthPlugin, { db: db as unknown as DBType });
    app.get(
      "/protected",
      { preHandler: app.authenticateApiKey },
      async (request) => ({
        userId: request.apiKey?.userId,
        organizationId: request.organization?.id,
      }),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it("accepts the verified key response and preserves its service account and organization", async () => {
    verifyApiKey.mockResolvedValue({ valid: true, error: null, key });
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": "test-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: "service-account-a",
      organizationId: "org-a",
    });
  });

  it("rejects a failed verification even if a key object is present", async () => {
    verifyApiKey.mockResolvedValue({ valid: false, key });
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": "test-key" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a key whose permissions belong to another organization", async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      key: { ...key, permissions: { "org-b": ["full_access"] } },
    });
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": "test-key" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects organization claims without a matching organization service account", async () => {
    verifyApiKey.mockResolvedValue({ valid: true, key });
    serviceAccount.mockResolvedValue([]);
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": "test-key" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects a malformed string permission containing full_access", async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      key: { ...key, permissions: { "org-a": "no_full_access" } },
    });
    const response = await app.inject({
      url: "/protected",
      headers: { "x-api-key": "test-key" },
    });
    expect(response.statusCode).toBe(403);
  });
});
