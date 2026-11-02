import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { OrgId } from '../auth/decorators/org-id.decorator';
import { ORG_MANAGERS, Roles } from '../auth/decorators/roles.decorator';
import { UpdateInvoiceSettingsSchema } from '../organization-settings/schemas/invoice-settings.schema';
import { ZodValidationPipe } from '../organization-settings/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import {
  IMAGE_STORAGE,
  type IImageStorage,
} from '../product/image-storage/image-storage.interface';
import { loadPreviewContext } from './render/build-loader';
import { renderDocumentPdf } from './render/document-pdf';
import { PREVIEW_SAMPLES, previewDocument } from './render/sample-documents';

export const InvoicePreviewSchema = z.object({
  sample: z.enum(PREVIEW_SAMPLES),
  /** The form as it stands, unsaved: laid over the saved settings for this preview only. */
  settings: UpdateInvoiceSettingsSchema.optional(),
});
export type InvoicePreviewInput = z.infer<typeof InvoicePreviewSchema>;

/**
 * The "Invoices & bills" settings page's live preview. Lives with the
 * invoices because it draws through their builders and renderer; the
 * settings themselves are saved by OrganizationSettingsController.
 */
@Controller('organization/settings/invoice')
export class InvoiceDesignController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMAGE_STORAGE) private readonly imageStorage: IImageStorage,
  ) {}

  // POST /api/v1/organization/settings/invoice/preview — a sample document
  // as a PDF, raw like GET /invoices/:id/pdf. Called on every change to the
  // form, so it saves nothing and reads only what the sample prints.
  @Post('preview')
  @HttpCode(200)
  @Roles(...ORG_MANAGERS)
  async preview(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(InvoicePreviewSchema))
    body: InvoicePreviewInput,
    @Res() res: Response,
  ) {
    const context = await loadPreviewContext(
      this.prisma,
      this.imageStorage,
      orgId,
      body.settings,
    );
    const buffer = await renderDocumentPdf(
      previewDocument(body.sample, context),
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }
}
