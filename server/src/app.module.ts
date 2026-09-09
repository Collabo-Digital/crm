import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { join } from 'path';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { FxModule } from './common/fx/fx.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { OrgRequiredGuard } from './auth/guards/org-required.guard';
import { VendorAccessGuard } from './auth/guards/vendor-access.guard';
import { InfluencerAccessGuard } from './auth/guards/influencer-access.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { SuperAdminGuard } from './auth/guards/super-admin.guard';
import { UserModule } from './user/user.module';
import { OrganizationModule } from './organization/organization.module';
import { OrganizationSettingsModule } from './organization-settings/organization-settings.module';
import { InwardSupplyModule } from './inward-supply/inward-supply.module';
import { EmailModule } from './email/email.module';
import { ChannelModule } from './channel/channel.module';
import { OrderModule } from './order/order.module';
import { DraftOrderModule } from './draft-order/draft-order.module';
import { ProductModule } from './product/product.module';
import { CustomerModule } from './customer/customer.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { GstModule } from './gst/gst.module';
import { InvoiceModule } from './invoice/invoice.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { AdminModule } from './admin/admin.module';
import { BillingModule } from './billing/billing.module';
import { InventoryModule } from './inventory/inventory.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validationSchema }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    // Only mount the static SPA when explicitly enabled.
    // Set SERVE_STATIC=true on full-stack deploys (Render/Railway).
    // Leave unset on API-only deploys (DigitalOcean Droplet) so the server
    // doesn't try to serve a non-existent client/build/client/ directory.
    ...(process.env.SERVE_STATIC === 'true'
      ? [
        ServeStaticModule.forRoot({
          rootPath: join(__dirname, '..', '..', '..', 'client', 'build', 'client'),
          exclude: ['/api/(.*)', '/uploads/(.*)'],
        }),
      ]
      : []),
    // Always mount /uploads (product images, future attachments). Local image
    // storage writes here; the path matches LocalImageStorage's URL builder.
    // For S3-backed deploys this is harmless — the bucket URL is returned
    // directly and clients never hit /uploads.
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    PrismaModule,
    RedisModule,
    FxModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('redis.url'),
        },
      }),
    }),
    EmailModule,
    AuthModule,
    UserModule,
    OrganizationModule,
    OrganizationSettingsModule,
    InwardSupplyModule,
    ChannelModule,
    OrderModule,
    DraftOrderModule,
    ProductModule,
    CustomerModule,
    DashboardModule,
    AnalyticsModule,
    GstModule,
    InvoiceModule,
    LoyaltyModule,
    AdminModule,
    BillingModule,
    InventoryModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: OrgRequiredGuard },
    { provide: APP_GUARD, useClass: VendorAccessGuard },
    // The other deny-by-default outside role. Sits beside VendorAccess: both
    // close every route their role has not been explicitly opened to.
    { provide: APP_GUARD, useClass: InfluencerAccessGuard },
    // After the outside-role guards so their rules resolve first; enforces
    // @RequirePermissions on top of @Roles (allow-by-default without it).
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: SuperAdminGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule { }