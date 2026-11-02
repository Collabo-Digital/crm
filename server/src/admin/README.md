# Admin Module (Super Admin)

Internal-only endpoints for the Collabo team. Mounted at `/api/v1/admin/*`.
Protected by `SuperAdminGuard` (registered globally in `app.module.ts`), which
reads `JwtPayload.isSuperAdmin` from the access token.

## How a user becomes a super admin

1. Their email appears in the `SUPER_ADMIN_EMAILS` env var (comma-separated).
2. On their next login (`AuthService.login`), `syncSuperAdminFlag` flips
   `User.isSuperAdmin = true` in the DB.
3. The freshly issued JWT carries `isSuperAdmin: true`.
4. `SuperAdminGuard` lets them through `@SuperAdmin()`-decorated routes.

To revoke: remove the email from the env var, then either wait for their token
to expire or call `POST /admin/users/:id/force-logout`.

## Endpoints

| Method | Path                                       | Purpose                                        |
| ------ | ------------------------------------------ | ---------------------------------------------- |
| GET    | /admin/users                               | Paginated list (search by name/email)          |
| GET    | /admin/users/:userId                       | User profile + memberships                     |
| POST   | /admin/users/:userId/impersonate           | Start session-swap → returns target's tokens   |
| POST   | /admin/stop-impersonating                  | End session-swap → returns super admin's tokens|
| PATCH  | /admin/users/:userId/soft-delete           | Sets deletedAt; revokes sessions               |
| PATCH  | /admin/users/:userId/reactivate            | Clears deletedAt                               |
| POST   | /admin/users/:userId/force-verify-email    | Bypass email OTP                               |
| POST   | /admin/users/:userId/force-logout          | Revokes all refresh tokens + sessions          |
| PATCH  | /admin/organizations/:orgId/billing        | Set plan / extend trial (see below)            |

## Impersonation mechanics

Implemented in `AuthService.startImpersonation` / `stopImpersonation`:

- Issues a fresh token pair where `sub` = target user, `isSuperAdmin: false`,
  `impersonatedBy: <super-admin-id>`.
- Writes a row to `impersonation_logs` with `startedAt`, `userAgent`, `ipAddress`.
- On stop, closes the open log row (`endedAt = now()`), then issues a token
  back to the super admin.
- `SuperAdminGuard` accepts both `isSuperAdmin === true` and any token with an
  `impersonatedBy` claim — so `stop-impersonating` is reachable mid-session
  without juggling two tokens client-side.

Audit log table: `impersonation_logs` (Prisma model `ImpersonationLog`).

## Set plan / extend trial

`PATCH /admin/organizations/:orgId/billing` with any of `billingPlan`,
`billingInterval`, `manual` (true: billing provider `MANUAL`, invoiced by the
Collabo team, as Scale and Enterprise are) and `trialEndsAt` (an ISO date, or
null to end the trial). A workspace paying through a Razorpay subscription
keeps the plan its subscription is on, so only its trial can change here.
Each change is logged as `Billing of org … set by super admin …` with the
values before and after. See docs/billing.md.
