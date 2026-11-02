import { Prisma } from '@prisma/client';
import { extractStateFromAddress } from '../gst/place-of-supply.util';
import { getStateName } from '../gst/constants/indian-states';

/**
 * A warehouse can be declared an ADDITIONAL PLACE OF BUSINESS (APOB) of one GST
 * registration. GST registers per STATE: one GSTIN covers a principal place of
 * business plus any number of additional places WITHIN THAT STATE. A godown in
 * another state is not an APOB of this registration at all — it needs its own.
 *
 * So the link is only valid when the warehouse's address resolves to the
 * registration's state. Returns the reason it is invalid, or null when the pair
 * is acceptable.
 *
 * SILENT ON MISSING FACTS, deliberately. No registration means "not linked",
 * which is always allowed. An address we cannot resolve a state from is not
 * evidence of a mismatch — merchants type partial addresses, and refusing them
 * would block the ordinary case of entering a name and code first, an address
 * later. The mismatch has to be positively provable to be reported.
 */
export function warehouseGstinMismatch(
  address: unknown,
  gstin: { stateCode: string; stateName: string } | null | undefined,
): string | null {
  if (!gstin) return null;

  const addressState = extractStateFromAddress(address);
  if (!addressState) return null;

  if (addressState === gstin.stateCode) return null;

  return `This GSTIN is for ${gstin.stateName} but the location is in ${stateLabel(addressState)}.`;
}

/**
 * The workspace's GST registration for a state, when it has one: the default
 * registration if it is in that state, else the oldest. What a location with
 * no GSTIN of its own operates under.
 */
export async function findStateGstin(
  db: Pick<Prisma.TransactionClient, 'organizationGstin'>,
  orgId: string,
  stateCode: string | null,
): Promise<{ id: string } | null> {
  if (!stateCode) return null;
  return db.organizationGstin.findFirst({
    where: { organizationId: orgId, stateCode, isActive: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
}

/**
 * What to tell the merchant about a location GST invoices cannot be issued
 * from: GST is on, the location is in a known state, and no active
 * registration covers that state. Null otherwise.
 */
export function locationGstWarning(
  location: { address: unknown; gstinId: string | null },
  gst: { enabled: boolean; activeGstins: Array<{ id: string; stateCode: string }> },
): string | null {
  if (!gst.enabled) return null;
  if (location.gstinId && gst.activeGstins.some((g) => g.id === location.gstinId)) return null;
  const stateCode = extractStateFromAddress(location.address);
  if (!stateCode || gst.activeGstins.some((g) => g.stateCode === stateCode)) return null;
  return `Add a GSTIN for ${stateLabel(stateCode)} to issue GST invoices for sales from here.`;
}

function stateLabel(stateCode: string): string {
  return getStateName(stateCode) ?? `state ${stateCode}`;
}
