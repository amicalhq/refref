import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { user, orgUser, apikey, org } from "../schema.js";
import { createId } from "@paralleldrive/cuid2";

/**
 * Service account utilities for managing organization-scoped API keys
 */

export interface ServiceAccount {
  id: string;
  email: string;
  name: string;
  role: string | null;
}

export interface ApiKeyWithMetadata {
  id: string;
  name: string | null;
  key: string; // Redacted format: "prefix_****last4"
  start: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  enabled: boolean | null;
  organizationId: string;
}

/**
 * Find service account for a given organization
 */
async function findServiceAccountForOrganization(
  db: PostgresJsDatabase<any>,
  organizationId: string,
): Promise<ServiceAccount | null> {
  const result = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    })
    .from(orgUser)
    .innerJoin(user, eq(orgUser.userId, user.id))
    .where(and(eq(orgUser.orgId, organizationId), eq(user.role, "service")))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Create service account for an organization
 * Idempotent with retry logic for race conditions
 */
async function createServiceAccount(
  db: PostgresJsDatabase<any>,
  organizationId: string,
  maxRetries = 3,
): Promise<ServiceAccount> {
  const serviceAccountEmail = `service-account_${organizationId}@refref.local`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // First check if it already exists
      const existing = await findServiceAccountForOrganization(
        db,
        organizationId,
      );
      if (existing) {
        return existing;
      }

      // Get organization details for the service account name
      const orgDetails = await db
        .select({ name: org.name })
        .from(org)
        .where(eq(org.id, organizationId))
        .limit(1);

      const orgName = orgDetails[0]?.name ?? "Unknown Organization";

      // Create the service account user
      const serviceAccountId = createId();

      await db.transaction(async (tx) => {
        // Insert user with role "service"
        await tx.insert(user).values({
          id: serviceAccountId,
          email: serviceAccountEmail,
          name: `Service Account - ${orgName}`,
          emailVerified: true,
          role: "service",
        });

        // Add to organization with "member" role
        await tx.insert(orgUser).values({
          orgId: organizationId,
          userId: serviceAccountId,
          role: "member",
        });
      });

      // Fetch and return the created account
      const created = await findServiceAccountForOrganization(
        db,
        organizationId,
      );
      if (!created) {
        throw new Error("Failed to create service account");
      }

      return created;
    } catch (error: any) {
      // Check if it's a duplicate error
      if (
        error?.message?.includes("duplicate") ||
        error?.code === "23505" // PostgreSQL unique violation
      ) {
        // Another request created it, try to fetch
        const existing = await findServiceAccountForOrganization(
          db,
          organizationId,
        );
        if (existing) {
          return existing;
        }
      }

      // If last attempt, throw
      if (attempt === maxRetries - 1) {
        throw error;
      }

      // Wait with exponential backoff before retry
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 100),
      );
    }
  }

  throw new Error("Failed to create service account after retries");
}

/**
 * Ensure service account exists for an organization
 * Creates if missing (idempotent)
 * @returns Service account user ID
 */
export async function ensureServiceAccountForOrganization(
  db: PostgresJsDatabase<any>,
  organizationId: string,
): Promise<string> {
  const serviceAccount = await createServiceAccount(db, organizationId);
  return serviceAccount.id;
}

/**
 * Get all API keys for an organization
 * Redacts the key value to show only prefix and last 4 characters
 */
export async function getApiKeysForOrganization(
  db: PostgresJsDatabase<any>,
  organizationId: string,
): Promise<ApiKeyWithMetadata[]> {
  // Get service account for this organization
  const serviceAccount = await findServiceAccountForOrganization(
    db,
    organizationId,
  );

  if (!serviceAccount) {
    // No service account = no API keys
    return [];
  }

  // Fetch all API keys for the service account
  const keys = await db
    .select()
    .from(apikey)
    .where(eq(apikey.referenceId, serviceAccount.id))
    .orderBy(apikey.createdAt);

  // Redact keys and parse metadata
  return keys.map((key) => {
    // Redact the key: show only start (prefix) and last 4 characters
    const redactedKey = key.start
      ? `${key.start}${"*".repeat(20)}${key.key.slice(-4)}`
      : `${"*".repeat(24)}${key.key.slice(-4)}`;

    return {
      id: key.id,
      name: key.name,
      key: redactedKey,
      start: key.start,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      enabled: key.enabled,
      organizationId,
    };
  });
}

/**
 * Validate if a user has permission to manage API keys for an organization
 * Only admin/owner of the organization can manage keys
 */
export async function validateApiKeyPermission(
  db: PostgresJsDatabase<any>,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  // Check if user is admin/owner of the organization
  const membership = await db
    .select({ role: orgUser.role })
    .from(orgUser)
    .where(and(eq(orgUser.orgId, organizationId), eq(orgUser.userId, userId)))
    .limit(1);

  const userRole = membership[0]?.role;
  return userRole === "admin" || userRole === "owner";
}

/**
 * Delete an API key for an organization
 * Verifies the key belongs to the organization's service account before deletion
 * @returns true if deleted, false if not found or doesn't belong to organization
 */
export async function deleteApiKeyForOrganization(
  db: PostgresJsDatabase<any>,
  organizationId: string,
  keyId: string,
): Promise<boolean> {
  // Get service account for this organization
  const serviceAccount = await findServiceAccountForOrganization(
    db,
    organizationId,
  );

  if (!serviceAccount) {
    return false;
  }

  // Delete the key only if it belongs to the organization's service account
  const result = await db
    .delete(apikey)
    .where(and(eq(apikey.id, keyId), eq(apikey.referenceId, serviceAccount.id)))
    .returning({ id: apikey.id });

  return result.length > 0;
}

/**
 * Clean up old product service accounts (migration helper)
 */
export async function cleanupProductServiceAccounts(
  db: PostgresJsDatabase<any>,
): Promise<void> {
  // Delete all service accounts that have the old product pattern
  // Pattern: service-account_{productId}@refref.local where productId is a CUID
  await db.delete(user).where(
    and(
      eq(user.role, "service"),
      // This will match the old pattern
      // We'll keep organization service accounts which have a different pattern
    ),
  );
}
