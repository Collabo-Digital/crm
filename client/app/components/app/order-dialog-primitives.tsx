import { useId, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

/**
 * What had focus when a pop-up opened, so it can be given back on close. A
 * menu item is gone by then, so a pop-up opened from a menu returns to the
 * menu's button instead.
 */
function opener(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  const menuButtonId = active?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
  return (menuButtonId && document.getElementById(menuButtonId)) || active;
}

/**
 * A pop-up that behaves as a dialog around a panel the caller styles: screen
 * readers hear it open under its title, Tab stays inside it, focus returns
 * when it closes, and Escape or a click on the backdrop calls `onClose`.
 * Render it while open and drop it to close. The panel must hold a
 * `ModalTitle`; `describedBy` is the id of the line that explains it, if any.
 */
export function ModalFrame({
  onClose,
  className,
  overlayClassName = "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4",
  describedBy,
  children,
}: {
  onClose: () => void;
  className?: string;
  overlayClassName?: string;
  describedBy?: string;
  children: React.ReactNode;
}) {
  const [returnFocusTo] = useState(opener);
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlayClassName}>
          <DialogPrimitive.Content
            aria-describedby={describedBy}
            className={className}
            onCloseAutoFocus={(event) => {
              // Radix would focus a Dialog.Trigger, which these pop-ups don't use.
              event.preventDefault();
              if (returnFocusTo?.isConnected) returnFocusTo.focus();
            }}
          >
            {children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The heading a `ModalFrame` is announced by (an h2). */
export const ModalTitle = DialogPrimitive.Title;

/**
 * Centered modal shell used by every order action dialog.
 * Click on the backdrop, press Escape or use the X button to dismiss. Body
 * content is rendered as children so each caller controls its own padding
 * and layout.
 */
export function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  maxWidthClass = "max-w-md",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidthClass?: string;
}) {
  const subtitleId = useId();
  return (
    <ModalFrame
      onClose={onClose}
      describedBy={subtitle ? subtitleId : undefined}
      className={`w-full ${maxWidthClass} rounded-xl bg-white dark:bg-gray-900 shadow-xl max-h-[90vh] overflow-y-auto outline-none`}
    >
      <div className="flex items-center justify-between border-b px-6 py-4 sticky top-0 bg-white dark:bg-gray-900">
        <div>
          <ModalTitle className="text-sm font-bold text-gray-900 dark:text-gray-100">{title}</ModalTitle>
          {subtitle && (
            <p id={subtitleId} className="text-[10px] text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="size-4" />
        </button>
      </div>
      {children}
    </ModalFrame>
  );
}

export function DialogFooter({
  confirmLabel,
  confirmTone = "primary",
  onConfirm,
  onClose,
  pending,
  confirmDisabled,
}: {
  confirmLabel: string;
  confirmTone?: "primary" | "destructive";
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  confirmDisabled?: boolean;
}) {
  const primaryClass =
    confirmTone === "destructive"
      ? "bg-red-600 text-white hover:bg-red-700"
      : "bg-[#cdff8c] text-gray-900 hover:bg-[#b8e67d]";
  return (
    <div className="flex items-center gap-2 border-t px-6 py-4">
      <button
        onClick={onConfirm}
        disabled={pending || confirmDisabled}
        className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-50 ${primaryClass}`}
      >
        {pending && <Loader2 className="size-3.5 animate-spin" />}
        {confirmLabel}
      </button>
      <button
        onClick={onClose}
        disabled={pending}
        className="rounded-lg px-4 py-2 text-xs text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
      >
        Close
      </button>
    </div>
  );
}

export function CheckboxRow({
  checked,
  onChange,
  label,
  help,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  help?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
        {help && (
          <span className="block text-[10px] text-muted-foreground">{help}</span>
        )}
      </span>
    </label>
  );
}
