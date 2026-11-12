import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { getAuth } from "../src/index";
import {
  schema,
  ensureServiceAccountForOrganization,
  getApiKeysForOrganization,
  deleteApiKeyForOrganization,
} from "@refref/coredb";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL;
const baseURL = "http://localhost:3000";

// Run only against an explicitly provisioned disposable database, never DATABASE_URL.
describe.skipIf(!databaseUrl)("PostgreSQL authentication compatibility", () => {
  const url = new URL(
    databaseUrl ?? "postgresql://postgres@localhost/refref_auth_test",
  );
  if (
    url.pathname !== "/refref_auth_test" ||
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    throw new Error(
      "AUTH_TEST_DATABASE_URL must name a local refref_auth_test database",
    );
  }
  const client = postgres(url.toString(), { max: 1 });
  const db = drizzle(client, { schema });
  const auth = getAuth({
    baseURL,
    db,
    schema,
    resendApiKey: "debug_key",
    enabledSocialAuth: [],
    enablePasswordAuth: true,
    enableMagicLinkAuth: false,
  });
  const email = `auth-${randomUUID()}@example.com`;
  const password = randomUUID();
  let userId: string;
  let orgId: string;
  let cookie: string;

  async function request(path: string, body?: unknown) {
    return auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: baseURL,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }

  beforeAll(async () => {
    const migration = await readFile(
      new URL(
        "../../coredb/scripts/migrations/20261112-api-key-config.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.unsafe(migration);
    const response = await request("/sign-up/email", {
      email,
      password,
      name: "Compatibility Test",
    });
    expect(response.status).toBe(200);
    userId = (await response.json()).user.id;
    const membership = await db.query.orgUser.findFirst({
      where: eq(schema.orgUser.userId, userId),
    });
    expect(membership?.role).toBe("owner");
    orgId = membership!.orgId;
  });

  afterAll(async () => {
    if (orgId) {
      const members = await db
        .select({ id: schema.orgUser.userId })
        .from(schema.orgUser)
        .where(eq(schema.orgUser.orgId, orgId));
      await db.delete(schema.org).where(eq(schema.org.id, orgId));
      for (const member of members)
        await db.delete(schema.user).where(eq(schema.user.id, member.id));
    } else if (userId) {
      await db.delete(schema.user).where(eq(schema.user.id, userId));
    }
    await client.end();
  });

  it("signs in an existing password account and reads its session", async () => {
    const response = await request("/sign-in/email", { email, password });
    expect(response.status).toBe(200);
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie).toContain("session_token");
    const session = await request("/get-session");
    expect((await session.json()).user.id).toBe(userId);
  });

  it("creates, verifies, lists and revokes an organization service-account key", async () => {
    const serviceAccountId = await ensureServiceAccountForOrganization(
      db,
      orgId,
    );
    const created = await auth.api.createApiKey({
      body: {
        name: "Compatibility Test",
        userId: serviceAccountId,
        metadata: { organizationId: orgId },
        permissions: { [orgId]: ["full_access"] },
      },
    });
    const verified = await auth.api.verifyApiKey({
      body: { key: created.key },
    });
    expect(verified.valid).toBe(true);
    expect(verified.key?.referenceId).toBe(serviceAccountId);
    expect(verified.key?.metadata?.organizationId).toBe(orgId);
    expect(
      (await getApiKeysForOrganization(db, orgId)).map((key) => key.id),
    ).toContain(created.id);
    const stranger = await db
      .insert(schema.org)
      .values({ name: "Other Organization", slug: randomUUID() })
      .returning();
    try {
      expect(
        await deleteApiKeyForOrganization(db, stranger[0]!.id, created.id),
      ).toBe(false);
      expect(await deleteApiKeyForOrganization(db, orgId, created.id)).toBe(
        true,
      );
      expect(
        (await auth.api.verifyApiKey({ body: { key: created.key } })).valid,
      ).toBe(false);
    } finally {
      await db.delete(schema.org).where(eq(schema.org.id, stranger[0]!.id));
    }
  });

  it("preserves an existing key and its user_id when applying the additive migration twice", async () => {
    const owner = await ensureServiceAccountForOrganization(db, orgId);
    // Better Auth 1.3.34: SHA-256 of UTF-8, encoded as unpadded base64url.
    const key =
      "prod_refref_key_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZab";
    const legacyHash = "WGWgWQq98VOX-QNxgQFUQBdbCy3uVb0910YblO6tyZE";
    const id = randomUUID();
    // Recreate the pre-upgrade shape only in this guarded disposable database.
    await client`ALTER TABLE apikey DROP COLUMN config_id`;
    await client`INSERT INTO apikey (id, user_id, key, enabled, metadata, permissions)
      VALUES (${id}, ${owner}, ${legacyHash}, true,
        ${JSON.stringify({ organizationId: orgId })}, ${JSON.stringify({ [orgId]: ["full_access"] })})`;
    const migration = await readFile(
      new URL(
        "../../coredb/scripts/migrations/20261112-api-key-config.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.unsafe(migration);
    await client.unsafe(migration);
    const [stored] =
      await client`SELECT user_id, config_id FROM apikey WHERE id=${id}`;
    expect(stored).toEqual({ user_id: owner, config_id: "default" });
    const verified = await auth.api.verifyApiKey({ body: { key } });
    expect(verified.valid).toBe(true);
    expect(verified.key?.referenceId).toBe(owner);
    expect(await deleteApiKeyForOrganization(db, orgId, id)).toBe(true);
  });
});
