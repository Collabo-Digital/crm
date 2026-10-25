-- A fingerprint of the last sheet row read, to find it again when rows above it are deleted.
-- AlterTable
ALTER TABLE "google_sheets" ADD COLUMN     "last_row_hash" TEXT;
