-- WhatsApp reports a played voice message as its own status, above READ.
-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'PLAYED';
