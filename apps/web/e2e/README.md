# Web e2e tests

## Pending

`requireAuth`/`requireOrganizationAccess` guard every route below, but `identifyUser` always
resolves to one seeded user (see `auth.e2e.ts`) — there's no way yet to drive a bystander or
signed-out request through a real route to see its 401/403. Add one e2e per row once real
sign-in lands.

| Route | Unit coverage today |
| --- | --- |
| `POST orgs/:id/reports` (create) | `create-report.test.ts` |
| `GET orgs/:id/reports/:id` (view) | `load-report.test.ts` |
| `POST orgs/:id/reports/:id/cancel` | `cancel.test.ts` (calls `requestCancellation` directly, bypassing auth) |
