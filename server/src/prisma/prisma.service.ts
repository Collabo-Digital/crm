import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
    extends PrismaClient
    implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);

    constructor() {
        super({
            log: [
                { emit: 'event', level: 'query' },
                { emit: 'stdout', level: 'info' },
                { emit: 'stdout', level: 'warn' },
                { emit: 'stdout', level: 'error' },
            ],
            // Workers and requests share a small pool. Under load (a broadcast,
            // a full sync) Prisma's 2 s default wait for a transaction's
            // connection fails sends that a few more seconds would let through.
            transactionOptions: { maxWait: 10_000 },
        });
    }

    async onModuleInit() {
        await this.$connect();
        this.logger.log('Database connection established');
    }

    async onModuleDestroy() {
        await this.$disconnect();
        this.logger.log('Database connection closed');
    }
}