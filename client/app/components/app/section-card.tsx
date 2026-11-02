import type { ReactNode } from "react";

import { Card, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { cn } from "~/lib/utils";

interface SectionCardProps {
    title: string;
    description?: string;
    /** Optional leading chip/icon rendered left of the title. */
    icon?: ReactNode;
    /** Trailing header slot — a "View All" link, a search box, a filter. */
    action?: ReactNode;
    className?: string;
    children: ReactNode;
}

/**
 * The one approved "panel with a header, a divider, and a body" surface.
 *
 * Wraps Card rather than being used raw: Card ships `py-4 gap-4` and CardHeader
 * ships `px-4`, while every panel in the app is `px-5 py-4` with a border-b — a
 * direct swap needs four className overrides at each call site. Pinning it once
 * keeps the pixels and gives one place to change them later.
 *
 * Body padding is the caller's business: some panels pad, some render an
 * edge-to-edge `divide-y` list or a full-bleed table.
 */
export function SectionCard({
    title,
    description,
    icon,
    action,
    className,
    children,
}: SectionCardProps) {
    return (
        <Card className={cn("gap-0 py-0 shadow-sm ring-border", className)}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                <div className="flex items-start gap-2">
                    {icon && <span className="mt-0.5 flex shrink-0">{icon}</span>}
                    <div>
                        <CardTitle className="text-body font-semibold">{title}</CardTitle>
                        {description && (
                            <CardDescription className="text-caption">{description}</CardDescription>
                        )}
                    </div>
                </div>
                {action}
            </CardHeader>
            {children}
        </Card>
    );
}
