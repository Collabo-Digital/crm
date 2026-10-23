import * as React from "react"

import { cn } from "~/lib/utils"

function PageHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="page-header"
            className={cn("flex flex-wrap items-start justify-between gap-3", className)}
            {...props}
        />
    )
}

function PageHeaderContent({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div data-slot="page-header-content" className={cn("min-w-0 space-y-1.5", className)} {...props} />
    )
}

function PageHeaderTitle({ className, ...props }: React.ComponentProps<"h1">) {
    return (
        <h1
            data-slot="page-header-title"
            className={cn("font-heading text-page-title --text-page-title--font-weight text-foreground", className)}
            {...props}
        />
    )
}

function PageHeaderDescription({ className, ...props }: React.ComponentProps<"p">) {
    return (
        <p
            data-slot="page-header-description"
            className={cn("text-body text-muted-foreground", className)}
            {...props}
        />
    )
}

function PageHeaderActions({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="page-header-actions"
            className={cn("flex max-w-full flex-wrap items-center gap-2", className)}
            {...props}
        />
    )
}

export {
    PageHeader,
    PageHeaderContent,
    PageHeaderTitle,
    PageHeaderDescription,
    PageHeaderActions,
}