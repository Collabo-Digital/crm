import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseTaxSettings } from '../organization-settings/schemas/tax-settings.schema';
import { getStateName } from './constants/indian-states';

/**
 * The composition scheme (CGST Act section 10). Such a seller charges no tax
 * on any sale, and cannot supply to another state at all (section 10(2)(c)),
 * so every path that prices or invoices a sale asks the same two questions
 * here, with one answer and one message.
 */

/** Whether the org sells under the composition scheme, read on the caller's client. */
export async function isCompositionSeller(
  client: Prisma.TransactionClient | PrismaService,
  orgId: string,
): Promise<boolean> {
  const row = await client.organizationSettings.findUnique({
    where: { organizationId: orgId },
    select: { taxSettings: true },
  });
  return parseTaxSettings(row?.taxSettings ?? null).composition;
}

/** The refusal of a sale to another state. An export (place of supply 96) is one. */
export function compositionInterStateError(
  placeOfSupplyCode: string,
  sellerStateCode: string,
): BadRequestException {
  const state = (code: string) => `${getStateName(code) ?? code} (${code})`;
  return new BadRequestException(
    "You're registered under the GST composition scheme, which doesn't allow sales to another state. " +
      `This sale's place of supply is ${state(placeOfSupplyCode)}; your registration is in ${state(sellerStateCode)}.`,
  );
}
