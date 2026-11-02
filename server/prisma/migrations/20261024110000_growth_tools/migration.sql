-- Growth tools: chat links with QR codes, and the website chat button and
-- number-capture pop-up. New tables only; nothing existing changes.

-- CreateTable
CREATE TABLE "growth_links" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "prefilled_text" TEXT,
    "tag" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "last_click_at" TIMESTAMP(3),
    "chats" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "growth_links_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "site_widgets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL,
    "allowed_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "button_link_id" TEXT,
    "popup_views" INTEGER NOT NULL DEFAULT 0,
    "signups" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_widgets_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE UNIQUE INDEX "growth_links_code_key" ON "growth_links"("code");


-- CreateIndex
CREATE INDEX "growth_links_organization_id_archived_at_idx" ON "growth_links"("organization_id", "archived_at");


-- CreateIndex
CREATE UNIQUE INDEX "site_widgets_organization_id_key" ON "site_widgets"("organization_id");


-- CreateIndex
CREATE UNIQUE INDEX "site_widgets_key_key" ON "site_widgets"("key");


-- CreateIndex
CREATE UNIQUE INDEX "site_widgets_button_link_id_key" ON "site_widgets"("button_link_id");


-- AddForeignKey
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "site_widgets" ADD CONSTRAINT "site_widgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "site_widgets" ADD CONSTRAINT "site_widgets_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

