import { createAuthClient } from "better-auth/react";
import {
  adminClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";
import { env } from "@/env";

/**
 * BetterAuth client setup with organization plugin for React components
 */
export const authClient = createAuthClient({
  // Base URL should match the server's baseURL
  baseURL: env.NEXT_PUBLIC_APP_URL,

  // Add the organization client plugin
  plugins: [
    adminClient(),
    apiKeyClient(),
    organizationClient(),
    magicLinkClient(),
  ],
});

// Export commonly used auth client methods
export const {
  // Session management
  useSession,
  getSession,

  // Authentication methods
  signIn,
  signUp,
  signOut,

  // Organization-related hooks and methods
  useListOrganizations,
  useActiveOrganization,

  // Organization management methods
  organization,
} = authClient;

// Export specific organization methods for convenience
export const {
  inviteMember,
  cancelInvitation,
  updateMemberRole,
  removeMember,
  listInvitations,
  acceptInvitation,
} = authClient.organization;
