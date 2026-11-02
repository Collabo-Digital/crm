-- How invoices, bills and receipts look. Nullable: an organization that never
-- saves these gets the schema defaults on read.
ALTER TABLE "organization_settings" ADD COLUMN "invoice_settings" JSONB;
