import { oneOf, useSessionState } from "~/hooks/use-session-state";
import { Link } from "react-router";
import { Package } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { EmptyState } from "./empty-state";
import { QueryErrorState } from "./query-error-state";
import { cn, formatCurrency } from "~/lib/utils";
import type {
    DashboardTopProduct,
    DashboardLowStockProduct,
    DashboardLowStockVariant,
} from "~/types/api";

type Tab = "top" | "low";

interface ProductsPanelProps {
    topProducts?: DashboardTopProduct[];
    lowStockProducts?: DashboardLowStockProduct[];
    lowStockVariants?: DashboardLowStockVariant[];
    /** The window the best sellers were counted over, e.g. "Last 7 days". */
    periodLabel?: string;
    isLoading?: boolean;
    /** The request failed: say so, rather than "no sales" or "well stocked". */
    onRetry?: () => void;
    currency: string;
    className?: string;
}

/**
 * Low Stock lists VARIANTS: the merchant restocks a size, not a product, so a
 * row reads "Screw nagas bangles [2.8] · 0 left". A server that predates
 * `lowStockVariants` still sends products — shown one row each, unnamed.
 */
function lowStockRows(
    variants: DashboardLowStockVariant[] | undefined,
    products: DashboardLowStockProduct[] | undefined,
): DashboardLowStockVariant[] | undefined {
    if (variants) return variants;
    return products?.map((p) => ({
        variantId: p.id,
        productId: p.id,
        productTitle: p.title,
        variantTitle: null,
        sku: null,
        stock: p.lowestVariantStock,
        image: p.image,
        threshold: p.threshold,
    }));
}

export function ProductsPanel({
    topProducts,
    lowStockProducts,
    lowStockVariants,
    periodLabel,
    isLoading,
    onRetry,
    currency,
    className,
}: ProductsPanelProps) {
    const [tab, setTab] = useSessionState<Tab>(
        "dashboard.products-tab",
        "top",
        oneOf(["top", "low"]),
    );
    const lowRows = lowStockRows(lowStockVariants, lowStockProducts);
    const lowCount = lowRows?.length ?? 0;
    const rows = tab === "top" ? topProducts : lowRows;
    const isEmpty = !isLoading && (!rows || rows.length === 0);

    return (
        <div className={cn("flex flex-col rounded-xl bg-card shadow-sm ring-1 ring-border", className)}>
            {/* Segmented control */}
            <div className="p-3">
                <div role="tablist" className="flex gap-1 rounded-full bg-muted p-1">
                    <TabButton active={tab === "top"} onClick={() => setTab("top")}>
                        Top Products
                    </TabButton>
                    <TabButton active={tab === "low"} onClick={() => setTab("low")}>
                        Low Stock{lowCount > 0 && ` (${lowCount})`}
                    </TabButton>
                </div>
            </div>

            {/* Meta row */}
            <div className="flex items-center justify-between px-5 pb-2">
                <p className="text-caption font-medium text-foreground">
                    {tab === "top" ? "Best sellers" : "Variants running low"}
                </p>
                <p className="text-caption text-muted-foreground">
                    {tab === "top" ? periodLabel : "Needs restock"}
                </p>
            </div>

            {/* Body */}
            <div className="flex flex-1 flex-col">
                {isLoading ? (
                    <div className="divide-y divide-border">
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div key={i} className="flex items-center gap-3 px-5 py-3">
                                <Skeleton className="size-5 rounded-full" />
                                <div className="flex-1 space-y-1.5">
                                    <Skeleton className="h-3 w-40" />
                                    <Skeleton className="h-3 w-24" />
                                </div>
                                <Skeleton className="h-4 w-16" />
                            </div>
                        ))}
                    </div>
                ) : onRetry ? (
                    <div className="flex flex-1 items-center justify-center px-5 py-12">
                        <QueryErrorState resource="your products" onRetry={onRetry} />
                    </div>
                ) : isEmpty ? (
                    <div className="flex flex-1 items-center justify-center px-5 py-12">
                        <EmptyState
                            icon={Package}
                            title={tab === "top" ? "No sales in this period" : "Everything is well stocked"}
                            description={
                                tab === "top"
                                    ? "Top sellers appear here once your products start selling."
                                    : "Variants at or below their reorder threshold will show up here."
                            }
                            action={
                                <Button variant="outline" asChild>
                                    <Link to="/products">Add product</Link>
                                </Button>
                            }
                        />
                    </div>
                ) : (
                    <ul className="divide-y divide-border">
                        {tab === "top"
                            ? topProducts!.map((p, i) => (
                                <ProductRow
                                    key={p.externalProductId}
                                    image={p.image}
                                    rank={i + 1}
                                    title={p.title}
                                    meta={`${p.totalQuantitySold} sold · ${p.currentStock} in stock`}
                                    value={formatCurrency(p.totalQuantitySold * parseFloat(p.price), currency)}
                                />
                            ))
                            : lowRows!.map((v, i) => (
                                <ProductRow
                                    key={v.variantId}
                                    image={v.image}
                                    rank={i + 1}
                                    title={v.productTitle}
                                    badge={v.variantTitle}
                                    meta={[v.sku && `SKU ${v.sku}`, `reorder at ${v.threshold}`]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    value={`${v.stock} left`}
                                    tone={v.stock <= 0 ? "danger" : "warning"}
                                />
                            ))}
                    </ul>
                )}
            </div>

            {/* Footer */}
            <div className="mt-auto border-t bg-muted/50">
                <Link
                    to="/products"
                    className="flex items-center justify-center py-3 text-caption font-medium text-brand-strong hover:text-brand-strong-hover"
                >
                    View All Products
                </Link>
            </div>
        </div>
    );
}

function TabButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            onClick={onClick}
            className={cn(
                "flex-1 rounded-full px-4 py-1.5 text-caption font-medium transition-colors",
                active
                    ? "bg-ink text-brand font-semibold"
                    : "text-muted-foreground hover:text-foreground"
            )}
        >
            {children}
        </button>
    );
}

function ProductRow({
    rank,
    image,
    title,
    badge,
    meta,
    value,
    tone,
}: {
    rank: number;
    image?: string | null;
    title: string;
    /** The variant this row is about, shown beside the product title. */
    badge?: string | null;
    meta: string;
    value: string;
    tone?: "danger" | "warning";
}) {
    return (
        <li className="flex items-center gap-3 px-5 py-3">
            <span
                className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-micro font-semibold tabular-nums",
                    rank === 1 ? "bg-brand text-brand-foreground" : "text-muted-foreground"
                )}
            >
                {rank}
            </span>

            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                {image ? (
                    <img src={image} alt="" className="size-full object-cover" />
                ) : (
                    <Package className="size-4 text-muted-foreground" />
                )}
            </div>

            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                    <p className="truncate text-caption font-semibold text-foreground">{title}</p>
                    {badge && (
                        <span
                            className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-micro font-semibold text-foreground ring-1 ring-border"
                            aria-label={`Variant ${badge}`}
                        >
                            {badge}
                        </span>
                    )}
                </div>
                <p className="text-micro text-muted-foreground">{meta}</p>
            </div>

            <span
                className={cn(
                    "shrink-0 text-caption font-semibold tabular-nums",
                    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning-strong" : "text-foreground"
                )}
            >
                {value}
            </span>
        </li>
    );
}