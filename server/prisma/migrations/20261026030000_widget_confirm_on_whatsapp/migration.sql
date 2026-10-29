-- Website pop-up sign-ups waiting to be confirmed on WhatsApp. New table only;
-- the "confirm on WhatsApp" switch lives in site_widgets.settings (JSON).
-- CreateTable
CREATE TABLE "widget_signups" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "widget_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "page" TEXT,
    "consent_text" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_signups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "widget_signups_organization_id_created_at_idx" ON "widget_signups"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "widget_signups_organization_id_code_key" ON "widget_signups"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "widget_signups" ADD CONSTRAINT "widget_signups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_signups" ADD CONSTRAINT "widget_signups_widget_id_fkey" FOREIGN KEY ("widget_id") REFERENCES "site_widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

