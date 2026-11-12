# Runtime dependency upgrade

This change upgrades the webapp, API, referral service and shared runtime packages. It does not configure a live deployment or connect business payment systems.

Use Node.js 24 and pnpm 10.23.0. Install with the committed lockfile. The API key server and browser plugins now come from `@better-auth/api-key` and `@better-auth/api-key/client` respectively. The API verifier consumes the current `{ valid, key }` response and checks service-account ownership as well as organization permissions.

## Existing databases

Back up the database and stop old webapp/API instances before applying the upgrade. Apply `packages/coredb/scripts/migrations/20261112-api-key-config.sql` using your normal offline PostgreSQL migration process, then deploy the upgraded applications together.

The migration adds only `apikey.config_id` with default `default`; existing key hashes, owners and metadata remain intact. The new Drizzle `referenceId` property maps to the existing `user_id` column and retains its foreign key. Do not rename or delete `user_id`, delete keys, or run the older product-to-organization migration as part of this upgrade.

For a new database, use the updated Drizzle schema. No business demo seed is required for these tests.

Better Auth now rejects organization invitations for unverified email accounts by default. Configure and verify the normal email verification flow before enabling invitations. Do not disable that verification check to restore older behavior. Before upgrading existing accounts, check for duplicate `(provider_id, account_id)` pairs and resolve any duplicates through verified identity records. See the [official upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide).

## Authentication regression tests

Provision an empty local PostgreSQL database named `refref_auth_test`, apply the current schema, and explicitly set `AUTH_TEST_DATABASE_URL` to that database for `pnpm --filter @refref/auth test`. The suite refuses remote hosts and other database names. It exercises password sign-in, session retrieval, organization service-account key creation/listing/revocation, cross-organization revocation refusal, and an existing key across two applications of the additive SQL migration.

The authentication tests alter the API key schema in their disposable database. Never point them at a shared development or production database. CI provisions its own PostgreSQL service and runs these tests along with the unit suite. A separate API PostgreSQL test uses `API_AUTH_TEST_DATABASE_URL` and runs afterward, so its authorization checks never race with the schema-changing authentication test. It exercises the real membership query with mismatched organizations, ordinary members and malformed permissions. The separate Playwright E2E suite still requires its configured application environment and is not included in the unit-test job.

Audit the entire workspace separately from deployed runtime paths. The marketing site, demonstration app and integration SDK retain independent dependency constraints; this runtime upgrade does not imply that every workspace advisory is resolved.
