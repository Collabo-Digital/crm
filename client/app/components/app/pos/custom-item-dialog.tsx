import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { GST_RATE_OPTIONS } from "~/lib/gst-uqc";

const selectClass = "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm";

/** A line for something not in the catalogue: a title, a GST-inclusive price, and its GST rate. */
export function CustomItemDialog({
  open,
  onOpenChange,
  gstEnabled,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gstEnabled: boolean;
  onAdd: (item: { title: string; price: number; gstRate: number | null }) => void;
}) {
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [gstRate, setGstRate] = useState("");
  const amount = Number(price);
  const valid = title.trim().length > 0 && price !== "" && Number.isFinite(amount) && amount > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setTitle("");
          setPrice("");
          setGstRate("");
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Custom item</DialogTitle>
          <DialogDescription>For something that is not in your catalogue. The price includes GST.</DialogDescription>
        </DialogHeader>
        <form
          id="pos-custom-item"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onAdd({ title: title.trim(), price: Math.round(amount * 100) / 100, gstRate: gstRate === "" ? null : Number(gstRate) });
            onOpenChange(false);
            setTitle("");
            setPrice("");
            setGstRate("");
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="pos-custom-title">Title</Label>
            <Input id="pos-custom-title" autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Alteration charge" className="h-11" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pos-custom-price">Price (₹)</Label>
              <Input id="pos-custom-price" type="number" inputMode="decimal" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="h-11 tabular-nums" />
            </div>
            {gstEnabled && (
              <div className="space-y-1.5">
                <Label htmlFor="pos-custom-gst">GST rate</Label>
                <select id="pos-custom-gst" className={selectClass} value={gstRate} onChange={(e) => setGstRate(e.target.value)}>
                  <option value="">Store default</option>
                  {GST_RATE_OPTIONS.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}%
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="pos-custom-item" variant="accent" disabled={!valid}>
            Add to cart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
