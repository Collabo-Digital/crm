import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Segment } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { contactName } from '../../messaging/contact-name';
import { RfmService } from './rfm.service';
import { SegmentDefinition, definitionWhere, parseDefinition } from './segment-rules';

export interface SaveSegmentInput {
    name: string;
    description?: string | null;
    definition: unknown;
}

const isUniqueViolation = (err: unknown) =>
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Saved audiences, and the live count and sample the rule editor shows. */
@Injectable()
export class SegmentsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly rfm: RfmService,
    ) { }

    async list(orgId: string) {
        const rows = await this.prisma.segment.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' } });
        return rows.map((s) => this.view(s));
    }

    async get(orgId: string, id: string) {
        return this.view(await this.load(orgId, id));
    }

    async create(orgId: string, userId: string, input: SaveSegmentInput) {
        const definition = parseDefinition(input.definition);
        const count = await this.count(orgId, definition);
        try {
            const row = await this.prisma.segment.create({
                data: {
                    organizationId: orgId,
                    name: input.name.trim(),
                    description: input.description?.trim() || null,
                    definition: definition as Prisma.InputJsonValue,
                    lastCount: count,
                    lastCountedAt: new Date(),
                    createdById: userId,
                },
            });
            return this.view(row);
        } catch (err) {
            if (isUniqueViolation(err)) throw new ConflictException('A segment with this name already exists.');
            throw err;
        }
    }

    async update(orgId: string, id: string, input: Partial<SaveSegmentInput>) {
        const segment = await this.load(orgId, id);
        const definition = input.definition !== undefined ? parseDefinition(input.definition) : (segment.definition as SegmentDefinition);
        const count = await this.count(orgId, definition);
        try {
            const row = await this.prisma.segment.update({
                where: { id: segment.id },
                data: {
                    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
                    ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
                    definition: definition as Prisma.InputJsonValue,
                    lastCount: count,
                    lastCountedAt: new Date(),
                },
            });
            return this.view(row);
        } catch (err) {
            if (isUniqueViolation(err)) throw new ConflictException('A segment with this name already exists.');
            throw err;
        }
    }

    async remove(orgId: string, id: string) {
        const segment = await this.load(orgId, id);
        await this.prisma.segment.delete({ where: { id: segment.id } });
        return { deleted: true };
    }

    /** Count and a few example contacts for a definition, saved or not. */
    async preview(orgId: string, raw: unknown) {
        const definition = parseDefinition(raw);
        const where = await this.where(orgId, definition);
        const [count, sample] = await Promise.all([
            this.prisma.channelContact.count({ where }),
            this.prisma.channelContact.findMany({
                where,
                take: 8,
                orderBy: { lastInboundMessageAt: { sort: 'desc', nulls: 'last' } },
                select: {
                    id: true, platform: true, phone: true, username: true, tags: true,
                    displayName: true, addressBookName: true, externalId: true,
                },
            }),
        ]);
        return {
            count,
            sample: sample.map((c) => ({ id: c.id, name: contactName(c), platform: c.platform, phone: c.phone, username: c.username, tags: c.tags })),
        };
    }

    async rfmSummary(orgId: string) {
        return this.rfm.summary(orgId);
    }

    /** The contacts a definition selects, within the organization. RFM scores are refreshed first when a rule needs them. */
    async where(orgId: string, definition: SegmentDefinition): Promise<Prisma.ChannelContactWhereInput> {
        if (definition.rules.some((r) => r.field === 'rfm')) await this.rfm.ensureFresh(orgId);
        return { AND: [{ organizationId: orgId }, definitionWhere(definition, new Date())] };
    }

    async load(orgId: string, id: string): Promise<Segment> {
        const row = await this.prisma.segment.findFirst({ where: { id, organizationId: orgId } });
        if (!row) throw new NotFoundException('Segment not found');
        return row;
    }

    private async count(orgId: string, definition: SegmentDefinition) {
        return this.prisma.channelContact.count({ where: await this.where(orgId, definition) });
    }

    private view(s: Segment) {
        return {
            id: s.id,
            name: s.name,
            description: s.description,
            definition: s.definition as SegmentDefinition,
            lastCount: s.lastCount,
            lastCountedAt: s.lastCountedAt,
            updatedAt: s.updatedAt,
        };
    }
}
