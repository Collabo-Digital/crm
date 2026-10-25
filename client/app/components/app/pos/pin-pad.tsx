import { useEffect, useState } from "react";
import { motion, useAnimationControls } from "framer-motion";
import { Delete, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const MIN_PIN = 4;
const MAX_PIN = 6;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/**
 * A 4–6 digit PIN pad for unlocking the till and for a manager's approval.
 * Takes taps or the keyboard's digits, Backspace and Enter. A refused PIN
 * shakes the dots and shows the server's sentence; `errorKey` changes on each
 * refusal so the same message twice still shakes.
 */
export function PinPad({
  title,
  description,
  submitLabel,
  pending,
  error,
  errorKey,
  onSubmit,
  className,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  errorKey: number;
  onSubmit: (pin: string) => void;
  className?: string;
}) {
  const [pin, setPin] = useState("");
  const shake = useAnimationControls();

  useEffect(() => {
    if (!errorKey) return;
    setPin("");
    void shake.start({ x: [0, -12, 12, -8, 8, -4, 4, 0], transition: { duration: 0.4 } });
  }, [errorKey, shake]);

  const press = (key: (typeof KEYS)[number]) => {
    if (pending) return;
    if (key === "clear") setPin("");
    else if (key === "back") setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < MAX_PIN ? p + key : p));
  };
  const submit = () => {
    if (!pending && pin.length >= MIN_PIN) onSubmit(pin);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) press(e.key as (typeof KEYS)[number]);
      else if (e.key === "Backspace") press("back");
      else if (e.key === "Enter") submit();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className={cn("mx-auto flex w-full max-w-xs flex-col items-center gap-5", className)}>
      <div className="space-y-1 text-center">
        <h2 className="font-heading text-subhead">{title}</h2>
        {description && <p className="text-caption text-muted-foreground">{description}</p>}
      </div>
      <motion.div animate={shake} className="flex h-4 items-center gap-3" aria-live="polite" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(MIN_PIN, pin.length) }, (_, i) => (
          <span
            key={i}
            className={cn("size-3.5 rounded-full border-2 border-foreground/70 transition-colors", i < pin.length && "bg-foreground", error && "border-danger")}
          />
        ))}
      </motion.div>
      <p role="alert" className="min-h-5 text-center text-caption text-danger">{error}</p>
      <div className="grid w-full grid-cols-3 gap-2.5">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            disabled={pending}
            onClick={() => press(key)}
            aria-label={key === "back" ? "Delete the last digit" : key === "clear" ? "Clear the PIN" : key}
            className={cn(
              "flex h-14 items-center justify-center rounded-2xl text-xl font-medium tabular-nums transition-colors active:scale-95 disabled:opacity-50",
              key === "clear" || key === "back" ? "text-caption text-muted-foreground hover:bg-muted" : "bg-muted hover:bg-muted/70",
            )}
          >
            {key === "back" ? <Delete className="size-5" /> : key === "clear" ? "Clear" : key}
          </button>
        ))}
      </div>
      <Button type="button" variant="accent" className="h-12 w-full text-body" disabled={pending || pin.length < MIN_PIN} onClick={submit}>
        {pending && <Loader2 className="animate-spin" />}
        {submitLabel}
      </Button>
    </div>
  );
}
