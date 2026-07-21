import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  Loader2,
  Pencil,
  Trash2,
  Check,
  AlertTriangle,
  Package,
  ExternalLink,
} from "lucide-react";
import { useProduct } from "~/hooks/use-product-queries";
import { useOrders } from "~/hooks/use-order-queries";
import { useDeleteProductMutation } from "~/hooks/use-product-mutations";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { ProductFormDialog } from "~/components/app/product-create/product-form-dialog";
import { ImageGalleryUploader } from "~/components/app/product-create/image-gallery-uploader";
import { VariantImageLink } from "~/components/app/product-create/variant-image-link";
import { DuplicateButton } from "~/components/app/products/duplicate-button";
import { cn, formatCurrency, formatMargin } from "~/lib/utils";
import { Calendar } from "lucide-react";

// Feature flag — media uploads are temporarily held while we finalize storage
// strategy. The backend endpoints stay live; only the UI entry points hide.
// Read-only display of Shopify-synced images still works. Flip to `true`
// to re-enable uploads, gallery editing, and variant-image linking.
const MEDIA_UPLOAD_ENABLED = false;

export function meta() {
  return [{ title: "Product Detail | Collabo CRM" }];
}

const STATUS_CLASS: Record<string, string> = {
  ACTIVE: "bg-[#CEF17B]/30 text-[#084734]",
  DRAFT: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  ARCHIVED: "bg-orange-100 text-orange-700",
};

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isVendor } = useCurrentRole();
  const { data: product, isLoading } = useProduct(id);
  const { data: org } = useCurrentOrg();
  const currency = org?.currency ?? "INR";
  const [editing, setEditing] = useState(false);
  const deleteMutation = useDeleteProductMutation();

  // Recent orders that contain this product (filtered server-side via the
  // new productId param we just added).
  const { data: recentOrders } = useOrders(
    id ? { productId: id, limit: 5 } : undefined,
  );

  if (isLoading || !product) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isManual = product.channel?.platform === "MANUAL";
  const meta = (product.metadata ?? {}) as Record<string, unknown>;
  const sync = (meta.shopifySync ?? null) as
    | { status: "PENDING" | "SYNCED" | "FAILED" | "OUT_OF_SYNC"; shopifyProductId?: string; error?: string }
    | null;
  const totalStock = product.totalStock ?? 0;

  function handleArchive() {
    if (!product) return;
    if (
      confirm(
        `Archive "${product.title}"? Existing orders will keep their record.`,
      )
    ) {
      deleteMutation.mutate(product.id, {
        onSuccess: () => navigate("/products"),
      });
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            to="/products"
            className="mb-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-gray-900 dark:hover:text-gray-100"
          >
            <ArrowLeft className="size-3.5" />
            Back to products
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{product.title}</h1>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                STATUS_CLASS[product.status] ?? "bg-gray-100 text-gray-600",
              )}
            >
              {product.status}
            </span>
            {isManual ? (
              <span className="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                CRM (Manual)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">
                <Check className="size-3" />
                Synced from {product.channel?.platform}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {product.vendor && <>Vendor: {product.vendor} • </>}
            {product.productType && <>Type: {product.productType} • </>}
            {totalStock} in stock
          </p>
          {product.status === "DRAFT" && product.publishedAt && new Date(product.publishedAt) > new Date() && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
              <Calendar className="size-3" />
              Publishes on {new Date(product.publishedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60"
          >
            <Pencil className="size-3.5" />
            Edit
          </button>
          {!isVendor && (
            <>
              <DuplicateButton productId={product.id} />
              <button
                onClick={handleArchive}
                className="inline-flex items-center gap-1.5 rounded-lg border border-input bg-white dark:bg-gray-900 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                <Trash2 className="size-3.5" />
                Archive
              </button>
            </>
          )}
          {!isManual && (
            <span className="text-[11px] text-muted-foreground italic">
              Synced from {product.channel?.name ?? "Shopify"}. Local edits push back when you click Sync.
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Media — read-only thumb grid (uploads currently held; see
           *  MEDIA_UPLOAD_ENABLED). When the flag flips on, MANUAL products
           *  get the full gallery uploader; until then we just show whatever
           *  images came from Shopify sync. Empty-state section is hidden
           *  entirely so we don't tease an upload UI we can't deliver. */}
          {product.images && product.images.length > 0 && (
            <Section title={`Media (${product.images.length})`}>
              {MEDIA_UPLOAD_ENABLED && isManual ? (
                <ImageGalleryUploader productId={product.id} images={product.images} />
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {product.images.map((img) => (
                    <img
                      key={img.id}
                      src={img.src}
                      alt={img.alt ?? ""}
                      className="aspect-square w-full rounded-lg object-cover"
                    />
                  ))}
                </div>
              )}
            </Section>
          )}
          {MEDIA_UPLOAD_ENABLED && isManual && (!product.images || product.images.length === 0) && (
            <Section title="Media">
              <ImageGalleryUploader productId={product.id} images={product.images ?? []} />
            </Section>
          )}

          {/* Description */}
          {product.bodyHtml && (
            <Section title="Description">
              <div
                className="prose prose-sm max-w-none dark:prose-invert text-xs"
                dangerouslySetInnerHTML={{ __html: product.bodyHtml }}
              />
            </Section>
          )}

          {/* Variants */}
          <Section title={`Variants (${product.variants.length})`}>
            <div className="overflow-x-auto -mx-5">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-5 py-2 text-left font-medium">Title</th>
                    <th className="px-5 py-2 text-left font-medium">SKU</th>
                    <th className="px-5 py-2 text-right font-medium">Price</th>
                    <th className="px-5 py-2 text-right font-medium">Cost</th>
                    <th className="px-5 py-2 text-right font-medium">Margin</th>
                    <th className="px-5 py-2 text-right font-medium">Stock</th>
                    <th className="px-5 py-2 text-right font-medium">Weight</th>
                    {MEDIA_UPLOAD_ENABLED && isManual && product.images && product.images.length > 0 && (
                      <th className="px-5 py-2 text-right font-medium">Image</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {product.variants.map((v) => {
                    const stockTracked = v.trackQuantity !== false;
                    return (
                      <tr key={v.id}>
                        <td className="px-5 py-3">
                          <p className="font-medium text-gray-900 dark:text-gray-100">{v.title}</p>
                          {(v.option1 || v.option2 || v.option3) && (
                            <p className="text-[10px] text-muted-foreground">
                              {[v.option1, v.option2, v.option3].filter(Boolean).join(" / ")}
                            </p>
                          )}
                          {v.barcode && (
                            <p className="text-[10px] font-mono text-muted-foreground">
                              {v.barcode}
                            </p>
                          )}
                        </td>
                        <td className="px-5 py-3 font-mono text-[11px] text-muted-foreground">
                          {v.sku ?? "—"}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums font-medium">
                          <div>{formatCurrency(v.price, currency)}</div>
                          {v.compareAtPrice && (
                            <div className="text-[10px] font-normal text-muted-foreground line-through">
                              {formatCurrency(v.compareAtPrice, currency)}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                          {v.cost != null ? formatCurrency(v.cost, currency) : "—"}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                          {formatMargin(v.price, v.cost, currency)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {!stockTracked ? (
                            <span className="text-[10px] italic text-muted-foreground" title="Not tracked">
                              Untracked
                            </span>
                          ) : (
                            <span
                              className={cn(
                                "font-medium",
                                v.inventoryQuantity === 0 && "text-red-600",
                                v.inventoryQuantity > 0 &&
                                  v.inventoryQuantity <= 5 &&
                                  "text-amber-600",
                              )}
                            >
                              {v.inventoryQuantity}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                          {v.weight != null
                            ? `${Number(v.weight)} ${v.weightUnit ?? ""}`
                            : "—"}
                        </td>
                        {MEDIA_UPLOAD_ENABLED && isManual && product.images && product.images.length > 0 && (
                          <td className="px-5 py-3 text-right">
                            <VariantImageLink
                              productId={product.id}
                              variantId={v.id}
                              currentImageId={v.imageId}
                              images={product.images}
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Recent sales */}
          <Section
            title={`Recent sales${
              recentOrders?.meta?.total ? ` (${recentOrders.meta.total} total)` : ""
            }`}
          >
            {recentOrders?.data?.length ? (
              <ul className="divide-y">
                {recentOrders.data.map((o) => (
                  <li key={o.id}>
                    <Link
                      to={`/orders/${o.id}`}
                      className="-mx-5 flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <div>
                        <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
                          {o.name}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {o.customer
                            ? `${o.customer.firstName ?? ""} ${o.customer.lastName ?? ""}`.trim() || "Guest"
                            : "Guest"}{" "}
                          • {new Date(o.createdAt).toLocaleDateString("en-IN")}
                        </p>
                      </div>
                      <p className="text-xs tabular-nums font-semibold">
                        {formatCurrency(o.totalPrice, currency)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No orders include this product yet.
              </p>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          {/* Stock summary */}
          <Section title="Inventory">
            <dl className="space-y-1.5 text-xs">
              <DescRow label="Total stock" value={String(totalStock)} icon={<Package className="size-3" />} />
              <DescRow label="Variants" value={String(product.variants.length)} />
            </dl>
          </Section>

          {/* GST */}
          {(product.hsnCode || product.gstRate != null) && (
            <Section title="GST">
              <dl className="space-y-1.5 text-xs">
                <DescRow label="HSN / SAC code" value={product.hsnCode || "—"} />
                <DescRow
                  label="GST rate"
                  value={
                    product.gstRate != null ? `${product.gstRate}%` : "—"
                  }
                />
              </dl>
            </Section>
          )}

          {/* Tags */}
          {product.tags && product.tags.length > 0 && (
            <Section title="Tags">
              <div className="flex flex-wrap gap-1">
                {product.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[10px] text-gray-700 dark:text-gray-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Channel */}
          <Section title="Channel">
            <p className="text-xs text-gray-900 dark:text-gray-100">
              {product.channel?.name ?? "—"}
            </p>
            <p className="text-[10px] text-muted-foreground">{product.channel?.platform}</p>
          </Section>

          {/* Shopify sync card */}
          {sync && (
            <Section title="Shopify Sync">
              <ShopifySyncCard sync={sync} />
            </Section>
          )}
        </div>
      </div>

      {/* Edit dialog */}
      {editing && (
        <ProductFormDialog
          productId={product.id}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function ShopifySyncCard({
  sync,
}: {
  sync: { status: "PENDING" | "SYNCED" | "FAILED" | "OUT_OF_SYNC"; shopifyProductId?: string; error?: string };
}) {
  if (sync.status === "SYNCED") {
    return (
      <div className="space-y-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">
          <Check className="size-3" />
          Synced
        </span>
        {sync.shopifyProductId && (
          <p className="text-[10px] text-muted-foreground">
            Shopify ID: <span className="font-mono">{sync.shopifyProductId}</span>
          </p>
        )}
      </div>
    );
  }
  if (sync.status === "PENDING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
        <Loader2 className="size-3 animate-spin" />
        Syncing
      </span>
    );
  }
  if (sync.status === "OUT_OF_SYNC") {
    return (
      <div className="space-y-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-3" />
          Out of sync
        </span>
        <p className="text-[10px] text-muted-foreground">
          Local edits haven't been pushed yet. Click <em>Sync to Shopify</em> when ready.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-900/30 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
        <AlertTriangle className="size-3" />
        Sync failed
      </span>
      {sync.error && <p className="text-[10px] text-red-700 dark:text-red-400">{sync.error}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border">
      <h2 className="border-b px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function DescRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="font-medium text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}
