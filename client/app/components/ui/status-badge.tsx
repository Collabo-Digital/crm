import * as React from "react"

import { STATUS_TONE_CLASSES, STATUS_TONE_DOTS, type StatusTone } from "~/lib/status-tone"
import { cn } from "~/lib/utils"

/**
 * The status pill: one shape and one palette for every status in the app.
 * Pass a `tone` (see lib/status-tone.ts). The per-feature maps in
 * lib/*-status.ts resolve to the same tone classes, so a `className` from one
 * of them works too.
 */
function StatusBadge({
  tone,
  dot = false,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  tone?: StatusTone
  /** A leading dot in the tone's colour. */
  dot?: boolean
}) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex h-5 w-fit max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-micro font-medium",
        tone && STATUS_TONE_CLASSES[tone],
        className
      )}
      {...props}
    >
      {dot && tone && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_TONE_DOTS[tone])} />}
      <span className="truncate">{children}</span>
    </span>
  )
}

export { StatusBadge }
