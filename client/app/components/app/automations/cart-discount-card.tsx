import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useSaveCartDiscountMutation } from "~/hooks/use-automation-mutations";
import type { CartDiscount } from "~/types/api";

const CODE = /^[A-Z0-9]{3,20}$/;

/**
 * The discount cart recovery offers in its third reminder. Optional: without
 * one, cart recovery sends two reminders. Collabo sends the code; the merchant
 * creates it in their store.
 */
export function CartDiscountCard({ discount, readOnly }: { discount: CartDiscount | null; readOnly: boolean }) {
  const save = useSaveCartDiscountMutation();
  const [code, setCode] = useState(discount?.code ?? "");
  const [text, setText] = useState(discount?.text ?? "");
  const [days, setDays] = useState(String(discount?.validDays ?? 3));

  // A save (or another tab) changes what is stored; show that.
  useEffect(() => {
    setCode(discount?.code ?? "");
    setText(discount?.text ?? "");
    setDays(String(discount?.validDays ?? 3));
  }, [discount?.code, discount?.text, discount?.validDays]);

  const validDays = Number(days);
  const errors = {
    code: code && !CODE.test(code) ? "Use 3 to 20 letters and numbers." : null,
    days: !Number.isInteger(validDays) || validDays < 1 || validDays > 30 ? "From 1 to 30 days." : null,
  };
  const complete = CODE.test(code) && text.trim().length > 0 && !errors.days;
  const changed = !discount || code !== discount.code || text.trim() !== discount.text || validDays !== discount.validDays;

  return (
    <SectionCard title="Cart recovery discount" description="Optional. With a code, cart recovery sends a third reminder a day after the first, with the discount and the day it ends.">
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (complete) save.mutate({ code, text: text.trim(), validDays });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="cd-code">Code</Label>
            <Input
              id="cd-code"
              value={code}
              disabled={readOnly}
              placeholder="SAVE200"
              aria-invalid={!!errors.code}
              aria-describedby="cd-code-help"
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20))}
              className="font-mono"
            />
            <p id="cd-code-help" className={errors.code ? "text-micro text-danger" : "text-micro text-muted-foreground"}>{errors.code ?? "Letters and numbers, as in your store."}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cd-text">Discount</Label>
            <Input id="cd-text" value={text} disabled={readOnly} maxLength={20} placeholder="₹200" onChange={(e) => setText(e.target.value)} />
            <p className="text-micro text-muted-foreground">What the shopper gets, like ₹200 or 10%.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cd-days">Valid for (days)</Label>
            <Input id="cd-days" type="number" inputMode="numeric" min={1} max={30} value={days} disabled={readOnly} aria-invalid={!!errors.days} aria-describedby="cd-days-help" onChange={(e) => setDays(e.target.value)} />
            <p id="cd-days-help" className={errors.days ? "text-micro text-danger" : "text-micro text-muted-foreground"}>{errors.days ?? "From the day the reminder is sent."}</p>
          </div>
        </div>
        <p className="text-caption text-muted-foreground">Create the code in your store first: Collabo sends it, but does not create it.</p>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="accent" size="sm" disabled={!complete || !changed || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              {discount ? "Save changes" : "Save discount"}
            </Button>
            {discount && (
              <Button type="button" variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate(null)}>
                Remove
              </Button>
            )}
          </div>
        )}
      </form>
    </SectionCard>
  );
}
