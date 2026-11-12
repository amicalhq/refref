import {
  betterAuth,
  type Auth as BetterAuthInstance,
  type BetterAuthOptions,
} from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import {
  renderMagicLinkEmail,
  renderInvitationEmail,
} from "@refref/email-templates";
import type { DBType } from "@refref/coredb";
import { Resend } from "resend";
import { eq, and, inArray } from "drizzle-orm";

export interface AuthConfig {
  /**
   * Base URL for the application (e.g., https://app.refref.ai)
   */
  baseURL: string;

  /**
   * Resend API key for sending emails
   */
  resendApiKey: string;

  /**
   * Database instance
   */
  db: DBType;

  /**
   * Database schema
   */
  schema: Record<string, any>;

  /**
   * Enabled social auth providers
   */
  enabledSocialAuth: string[];

  /**
   * Enable password authentication
   */
  enablePasswordAuth: boolean;

  /**
   * Enable magic link authentication
   */
  enableMagicLinkAuth: boolean;

  /**
   * Google OAuth credentials (optional)
   */
  google?: {
    clientId: string;
    clientSecret: string;
  };

  /**
   * Logger instance
   */
  logger?: {
    info: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
  };

  /**
   * PostHog instance for analytics
   */
  posthog?: {
    capture: (event: {
      distinctId: string;
      event: string;
      properties?: any;
    }) => void;
  };

  /**
   * Trusted origins for CORS
   */
  trustedOrigins?: string[];

  /**
   * Email address to use as the sender for notifications
   */
  emailFrom?: string;
}

/**
 * Creates a Better Auth instance with the provided configuration
 */
type RefRefAuthOptions = Pick<
  BetterAuthOptions,
  | "baseURL"
  | "database"
  | "socialProviders"
  | "emailAndPassword"
  | "trustedOrigins"
  | "databaseHooks"
> & {
  plugins: [
    ReturnType<typeof organization>,
    ReturnType<typeof apiKey>,
    ...ReturnType<typeof magicLink>[],
  ];
};

export type Auth = BetterAuthInstance<RefRefAuthOptions>;

export function getAuth(config: AuthConfig): Auth {
  const {
    baseURL,
    resendApiKey,
    db,
    schema,
    enabledSocialAuth,
    enablePasswordAuth,
    enableMagicLinkAuth,
    google,
    logger,
    posthog,
    trustedOrigins = [baseURL],
    emailFrom = "RefRef <notifications@mail.refref.ai>",
  } = config;

  // Build social providers object dynamically based on enabled providers
  const socialProviders = enabledSocialAuth.reduce(
    (acc, provider) => {
      if (provider === "google" && google) {
        return {
          ...acc,
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
          },
        };
      }
      // Add more providers here as needed (github, etc.)
      return acc;
    },
    {} as Record<string, { clientId: string; clientSecret: string }>,
  );

  // Initialize Resend for email sending
  const resend = new Resend(resendApiKey);

  const options = {
    baseURL,
    socialProviders,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        ...schema,
      },
    }),
    emailAndPassword: {
      enabled: enablePasswordAuth,
    },
    trustedOrigins,
    plugins: [
      organization({
        schema: {
          organization: {
            modelName: "org",
          },
          session: {
            modelName: "session",
            fields: {
              activeOrganizationId: "activeOrganizationId",
            },
          },
          member: {
            modelName: "orgUser",
            fields: {
              organizationId: "orgId",
            },
          },
          invitation: {
            modelName: "invitation",
            fields: {
              organizationId: "organizationId",
            },
          },
        },
        async sendInvitationEmail({ id, email, role, inviter }) {
          const inviteLink = `${baseURL}/accept-invitation/${id}`;
          logger?.info("Sending invitation email", { inviteLink, email, role });

          const emailContent = await renderInvitationEmail({
            role,
            inviterName: inviter?.user?.name,
            inviterEmail: inviter?.user?.email,
            inviteLink,
          });

          await resend.emails.send({
            from: emailFrom,
            to: email,
            subject: "You've been invited to RefRef",
            html: emailContent,
          });
        },
        organizationHooks: {
          async afterAddMember({ member }) {
            try {
              const { product, productUser, program, programUser, user } =
                schema;

              // Check if user is a service account (service accounts have no email or special naming)
              const [userRecord] = await db
                .select()
                .from(user)
                .where(eq(user.id, member.userId))
                .limit(1);

              // Skip sync for service accounts (identified by email pattern or other criteria)
              if (
                userRecord?.email?.includes("service-account") ||
                userRecord?.name?.includes("Service Account")
              ) {
                logger?.info("Skipping member sync for service account", {
                  userId: member.userId,
                });
                return;
              }

              // Get the product for this organization
              const [orgProduct] = await db
                .select()
                .from(product)
                .where(eq(product.orgId, member.organizationId))
                .limit(1);

              if (!orgProduct) {
                logger?.info("No product found for organization", {
                  organizationId: member.organizationId,
                });
                return;
              }

              // Add user to productUser table
              await db.insert(productUser).values({
                productId: orgProduct.id,
                userId: member.userId,
                role: member.role,
              });

              // Get all programs for this product
              const programs = await db
                .select()
                .from(program)
                .where(eq(program.productId, orgProduct.id));

              // Add user to all programs
              if (programs.length > 0) {
                await db.insert(programUser).values(
                  programs.map((prog) => ({
                    programId: prog.id,
                    userId: member.userId,
                    role: member.role,
                  })),
                );
              }

              logger?.info(
                "Successfully synced member to product and programs",
                {
                  userId: member.userId,
                  organizationId: member.organizationId,
                  productId: orgProduct.id,
                  programCount: programs.length,
                },
              );
            } catch (error) {
              logger?.error("Failed to sync member to product and programs", {
                error,
                userId: member.userId,
                organizationId: member.organizationId,
              });
              // Don't throw - allow member addition to succeed even if sync fails
            }
          },
          async beforeRemoveMember({ member }) {
            try {
              const { product, productUser, program, programUser } = schema;

              // Get the product for this organization
              const [orgProduct] = await db
                .select()
                .from(product)
                .where(eq(product.orgId, member.organizationId))
                .limit(1);

              if (!orgProduct) {
                logger?.info(
                  "No product found for organization during removal",
                  {
                    organizationId: member.organizationId,
                  },
                );
                return;
              }

              // Get all program IDs for this product
              const programs = await db
                .select({ id: program.id })
                .from(program)
                .where(eq(program.productId, orgProduct.id));

              // Remove from programUser entries for this product's programs
              if (programs.length > 0) {
                await db.delete(programUser).where(
                  and(
                    eq(programUser.userId, member.userId),
                    inArray(
                      programUser.programId,
                      programs.map((p) => p.id),
                    ),
                  ),
                );
              }

              // Remove from productUser table
              await db
                .delete(productUser)
                .where(
                  and(
                    eq(productUser.productId, orgProduct.id),
                    eq(productUser.userId, member.userId),
                  ),
                );

              logger?.info(
                "Successfully removed member from product and programs",
                {
                  userId: member.userId,
                  organizationId: member.organizationId,
                  productId: orgProduct.id,
                  programCount: programs.length,
                },
              );
            } catch (error) {
              logger?.error(
                "Failed to remove member from product and programs",
                {
                  error,
                  userId: member.userId,
                  organizationId: member.organizationId,
                },
              );
              // Don't throw - allow member removal to succeed even if cleanup fails
            }
          },
        },
      }),
      apiKey({
        defaultPrefix: "prod_refref_key_",
        enableMetadata: true,
      }),
      ...(enableMagicLinkAuth
        ? [
            magicLink({
              sendMagicLink: async ({ email, url }) => {
                try {
                  logger?.info("Sending magic link email", { url, email });

                  const emailContent = await renderMagicLinkEmail(url);

                  await resend.emails.send({
                    from: emailFrom,
                    to: email,
                    subject: "Your Magic Link to Sign In",
                    html: emailContent,
                  });

                  logger?.info("Magic link email sent successfully", { email });
                } catch (error) {
                  console.error("Error sending magic link email", {
                    error,
                    email,
                  });
                  logger?.error("Error sending magic link email", {
                    error,
                    email,
                  });
                  throw error;
                }
              },
            }),
          ]
        : []),
    ] satisfies RefRefAuthOptions["plugins"],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // Track user signup event
            posthog?.capture({
              distinctId: user.id,
              event: "user_sign_up",
              properties: {
                email: user.email,
                name: user.name || undefined,
              },
            });

            // Auto-create default organization for new users
            try {
              const { org: orgTable, orgUser } = schema;

              // Check if user is already a member of any organization
              const existingMembership = await db
                .select()
                .from(orgUser)
                .where(eq(orgUser.userId, user.id))
                .limit(1);

              if (existingMembership.length > 0) {
                logger?.info(
                  "User already has org membership, skipping default org creation",
                  {
                    userId: user.id,
                    orgId: existingMembership[0]!.orgId,
                  },
                );
                return;
              }

              // Create default organization
              const [newOrg] = await db
                .insert(orgTable)
                .values({
                  name: `${user.name || user.email}'s Organization`,
                  slug: `org-${user.id.slice(0, 8)}`,
                })
                .returning();

              // Add user as owner of the organization
              await db.insert(orgUser).values({
                orgId: newOrg!.id,
                userId: user.id,
                role: "owner",
              });

              logger?.info("Created default organization for new user", {
                userId: user.id,
                organizationId: newOrg!.id,
              });
            } catch (error) {
              logger?.error("Failed to create default organization for user", {
                userId: user.id,
                error,
              });
              // Don't throw - allow user creation to succeed even if org creation fails
            }
          },
        },
      },
    },
  } satisfies BetterAuthOptions;

  return betterAuth<RefRefAuthOptions>(options);
}
