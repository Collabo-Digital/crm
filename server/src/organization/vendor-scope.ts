import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The vendor a VENDOR member is scoped to: required, and it must name a vendor
 * the organization has products for. A VENDOR without a scope is refused on
 * every route (VendorAccessGuard), so letting one through locks the member out.
 */
export async function resolveVendorScope(
    prisma: PrismaService,
    orgId: string,
    raw: string | undefined,
): Promise<string> {
    const scope = raw?.trim();
    if (!scope) {
        throw new BadRequestException('Choose which vendor this member supplies.');
    }
    const hasProducts = await prisma.product.findFirst({
        where: {
            organizationId: orgId,
            deletedAt: null,
            OR: [{ vendorKey: scope }, { vendor: scope }],
        },
        select: { id: true },
    });
    if (!hasProducts) {
        throw new BadRequestException(`No products found for vendor "${scope}".`);
    }
    return scope;
}
