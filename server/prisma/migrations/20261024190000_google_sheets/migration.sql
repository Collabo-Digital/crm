-- Google Sheets for automations: the organization's Google account (drive.file) and the sheets it uses.
-- CreateTable
CREATE TABLE "google_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT,
    "credentials" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connected_by_id" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_sheets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "spreadsheet_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "tab" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "seen_rows" INTEGER,
    "checked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "skipped_row" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_accounts_organization_id_key" ON "google_accounts"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "google_sheets_organization_id_spreadsheet_id_key" ON "google_sheets"("organization_id", "spreadsheet_id");

-- AddForeignKey
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheets" ADD CONSTRAINT "google_sheets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
