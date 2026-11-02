import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InviteStatus, Prisma, PrismaClient, UserRole } from '@prisma/client';

/**
 * Store scoping: a Manager or Agent limited to the stock locations (stores and
 * warehouses, i.e. Warehouse ids) they work at, through
 * `OrganizationMember.locationScope`. An empty list means every location, so
 * every member who joined before this keeps the access they had.
 *
 * Owner and Admin always work everywhere, and every other role ignores the
 * list: a Viewer's reads are not limited, and Vendors and Influencers are
 * shut out of stock by their own guards.
 *
 * Writes outside the scope are refused with a 403; lists are filtered without
 * saying so. The online orders list is deliberately left alone.
 */
export const LOCATION_SCOPED_ROLES: UserRole[] = [UserRole.MANAGER, UserRole.AGENT];

type Db = PrismaClient | Prisma.TransactionClient;

export const STORE_SCOPING_UPGRADE =
  'Choosing the stores a member works at is part of the Unlimited plan. Book a demo with us to move up.';

/**
 * The locations this member works at, or null for every location.
 *
 * Read from the membership on each call rather than from the session cache,
 * so a change in Team members applies to the very next request. Only Managers
 * and Agents cost a query. A membership that cannot be found works nowhere.
 */
export async function locationScopeFor(
  db: Db,
  user: { sub: string; orgId?: string; role?: UserRole },
): Promise<string[] | null> {
  if (!user.orgId || !user.role || !LOCATION_SCOPED_ROLES.includes(user.role)) return null;
  const member = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: user.orgId, userId: user.sub } },
    select: { locationScope: true },
  });
  if (!member) return [];
  return member.locationScope.length > 0 ? member.locationScope : null;
}

/** Does the member work at this location? Everyone works at every location when there is no scope. */
export function inLocationScope(scope: string[] | null, locationId: string | null | undefined): boolean {
  return scope === null || (!!locationId && scope.includes(locationId));
}

/** Changing stock, or a location's set-up, somewhere the member does not work. */
export const STOCK_OUT_OF_SCOPE =
  'You can only change stock at the locations you work at. Ask an owner or admin to add this one to your stores.';

export function assertInLocationScope(
  scope: string[] | null,
  locationId: string | null | undefined,
  message = "You don't work at this location. Ask an owner or admin to add it to your stores.",
): void {
  if (!inLocationScope(scope, locationId)) throw new ForbiddenException(message);
}

/**
 * A `warehouseId` condition for a list: the location asked for, kept inside
 * the scope. A location outside it matches nothing rather than erroring, and
 * no location asked for means every location in the scope.
 */
export function scopedLocationFilter(
  scope: string[] | null,
  requested?: string,
): string | { in: string[] } | undefined {
  if (scope === null) return requested || undefined;
  if (requested) return scope.includes(requested) ? requested : { in: [] };
  return { in: scope };
}

/** The same condition for raw SQL on `column`, as an `AND …` fragment. */
export function scopedLocationSql(
  column: Prisma.Sql,
  scope: string[] | null,
  requested?: string,
): Prisma.Sql {
  const filter = scopedLocationFilter(scope, requested);
  if (filter === undefined) return Prisma.empty;
  if (typeof filter === 'string') return Prisma.sql`AND ${column} = ${filter}`;
  return Prisma.sql`AND ${column} = ANY(${filter.in}::text[])`;
}

/**
 * The scope to save for a member or invitation of `role`: the org's own
 * locations, each once. `allowed` is whether the org's plan includes it
 * (BillingAccessService.allows(orgId, 'storeScoping')).
 * Clearing a scope is always allowed, on any plan and for any role.
 */
export async function resolveLocationScope(
  db: Db,
  orgId: string,
  role: UserRole,
  ids: string[] | undefined,
  allowed: boolean,
): Promise<string[]> {
  if (!ids || ids.length === 0) return [];
  if (!LOCATION_SCOPED_ROLES.includes(role)) {
    throw new BadRequestException('Only managers and agents can be limited to stores.');
  }
  if (!allowed) throw new ForbiddenException(STORE_SCOPING_UPGRADE);
  const unique = [...new Set(ids)];
  const found = await db.warehouse.count({ where: { organizationId: orgId, id: { in: unique } } });
  if (found !== unique.length) {
    throw new BadRequestException("Pick the stores from this workspace's own locations.");
  }
  return unique;
}

/**
 * Who would be left working nowhere if these locations closed: active
 * Managers and Agents, and pending invitations for one, whose every location
 * is among them. Names for a refusal, people before invitations.
 */
export async function onlyAtLocations(db: Db, orgId: string, locationIds: string[]): Promise<string[]> {
  const [members, invites] = await Promise.all([
    db.organizationMember.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
        role: { in: LOCATION_SCOPED_ROLES },
        locationScope: { hasSome: locationIds },
      },
      select: { locationScope: true, user: { select: { firstName: true, lastName: true, email: true } } },
    }),
    db.teamInvite.findMany({
      where: {
        organizationId: orgId,
        status: InviteStatus.PENDING,
        role: { in: LOCATION_SCOPED_ROLES },
        locationScope: { hasSome: locationIds },
      },
      select: { locationScope: true, email: true, name: true },
    }),
  ]);
  const only = (scope: string[]) => scope.every((id) => locationIds.includes(id));
  return [
    ...members
      .filter((m) => only(m.locationScope))
      .map((m) => `${m.user.firstName} ${m.user.lastName}`.trim() || m.user.email),
    ...invites.filter((i) => only(i.locationScope)).map((i) => i.name || i.email),
  ];
}

/**
 * Takes switched-off locations out of every member's and invitation's scope.
 * A Manager or Agent whose only locations they were keeps them instead: an
 * emptied scope would mean every location, and switching a store off must
 * never widen what anyone sees. The manual switch-off refuses that case up
 * front (see WarehouseService.update); a Shopify location closing cannot be
 * refused, so there they stay limited to the closed location.
 */
export async function removeFromLocationScopes(db: Db, orgId: string, locationIds: string[]): Promise<void> {
  if (locationIds.length === 0) return;
  const kept = Prisma.sql`ARRAY(SELECT x FROM unnest("location_scope") AS x WHERE x <> ALL(${locationIds}::text[]))`;
  const stays = Prisma.sql`("role" NOT IN ('MANAGER', 'AGENT') OR NOT ("location_scope" <@ ${locationIds}::text[]))`;
  await db.$executeRaw`
    UPDATE "organization_members"
    SET "location_scope" = ${kept}, "updated_at" = now()
    WHERE "organization_id" = ${orgId}
      AND "location_scope" && ${locationIds}::text[]
      AND ${stays}`;
  await db.$executeRaw`
    UPDATE "team_invites"
    SET "location_scope" = ${kept}, "updated_at" = now()
    WHERE "organization_id" = ${orgId}
      AND "location_scope" && ${locationIds}::text[]
      AND ${stays}`;
}
