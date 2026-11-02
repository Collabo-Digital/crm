-- Store scoping: the stock locations a Manager or Agent works at, on the
-- membership and on the invitation it is accepted from. Empty means every
-- location, which is what every existing member keeps.

-- AlterTable
ALTER TABLE "organization_members" ADD COLUMN     "location_scope" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "team_invites" ADD COLUMN     "location_scope" TEXT[] DEFAULT ARRAY[]::TEXT[];
