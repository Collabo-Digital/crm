-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "order_catch_up_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "shopify_inventory_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stock_levels" ADD COLUMN     "shopify_updated_at" TIMESTAMP(3);
