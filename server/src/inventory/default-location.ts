import { Prisma, StockLocationKind } from '@prisma/client';
import {
  InventorySettingsSchema,
  parseInventorySettings,
} from '../organization-settings/schemas/inventory-settings.schema';

export const DEFAULT_LOCATION_NAME = 'Main warehouse';
export const DEFAULT_LOCATION_CODE = 'WH1';

/**
 * A workspace's stock locations from its first moment: the "Main warehouse"
 * as the default, and warehousing switched on.
 *
 * Only for a workspace with no stock yet. One that already has stock goes
 * through `InventoryService.enable`, which seeds it into the default location
 * BEFORE flipping the flag; flipping it here first would strand that stock in
 * the legacy single-quantity column.
 *
 * Idempotent: an existing default location is kept.
 */
export async function ensureDefaultLocation(
  tx: Prisma.TransactionClient,
  orgId: string,
): Promise<{ id: string }> {
  const warehouse =
    (await tx.warehouse.findFirst({
      where: { organizationId: orgId, isDefault: true },
      select: { id: true },
    })) ??
    (await tx.warehouse.create({
      data: {
        organizationId: orgId,
        name: DEFAULT_LOCATION_NAME,
        code: DEFAULT_LOCATION_CODE,
        kind: StockLocationKind.WAREHOUSE,
        isDefault: true,
      },
      select: { id: true },
    }));

  const row = await tx.organizationSettings.findUnique({
    where: { organizationId: orgId },
    select: { inventorySettings: true },
  });
  const inventorySettings = InventorySettingsSchema.parse({
    ...parseInventorySettings(row?.inventorySettings ?? null),
    warehousingEnabled: true,
  }) as Prisma.InputJsonValue;
  await tx.organizationSettings.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, inventorySettings },
    update: { inventorySettings },
  });
  return warehouse;
}
