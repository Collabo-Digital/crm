"use client"

import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"
import { Circle } from "lucide-react"

import { cn } from "~/lib/utils"

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-4 shrink-0 rounded-full border border-input text-ink shadow-xs transition-[color,box-shadow]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-ink",
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <Circle className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-ink text-ink" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
}

/**
 * A whole card acting as one radio option — the pickup-location and payment
 * steps of the create-shipment wizard. The `<Item>` sits inside the label so
 * clicking anywhere on the card selects it, and `has-data-[state=checked]`
 * lights the border without the caller tracking selection in React state.
 */
function RadioCard({
  className,
  children,
  value,
  disabled,
  id,
}: {
  className?: string
  children: React.ReactNode
  value: string
  disabled?: boolean
  id?: string
}) {
  return (
    <label
      htmlFor={id ?? `radio-card-${value}`}
      className={cn(
        "relative flex cursor-pointer gap-3 rounded-lg border border-border bg-card p-4 transition-colors",
        "hover:border-ink/30 has-data-[state=checked]:border-ink has-data-[state=checked]:ring-1 has-data-[state=checked]:ring-ink",
        disabled && "pointer-events-none opacity-55",
        className
      )}
    >
      <RadioGroupItem value={value} id={id ?? `radio-card-${value}`} disabled={disabled} className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  )
}

export { RadioGroup, RadioGroupItem, RadioCard }
