import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import {
  Camera,
  ChevronRight,
  CirclePause,
  Ellipsis,
  Loader2,
  PackageCheck,
  Play,
  RotateCcw,
  ScanBarcode,
  TriangleAlert,
} from "lucide-react";
import { CameraScanner, type ScanFeedback } from "~/components/app/pos/camera-scanner";
import { EmptyState } from "~/components/app/empty-state";
import { PackingBadges } from "~/components/app/packing/packing-badges";
import { PackLine, type LineAction } from "~/components/app/packing/pack-line";
import { FinishDialog, LineDialog, StartOverDialog, type LineDialogMode } from "~/components/app/packing/pack-dialogs";
import { ScanBanner, type ShownFeedback } from "~/components/app/packing/scan-banner";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { useKeyboardWedge } from "~/hooks/use-barcode-wedge";
import { useListReturnPath } from "~/hooks/use-list-url-state";
import { useMediaQuery } from "~/hooks/use-media-query";
import { usePackingStart, usePackTask } from "~/hooks/use-packing-queries";
import { usePackTaskActions, useScanMutation } from "~/hooks/use-packing-mutations";
import { serverMessage } from "~/lib/handle-mutation-error";
import {
  finishOptions,
  firstName,
  holdReasonLabel,
  itemsWord,
  packedTime,
  paymentBadges,
  productName,
  scanFeedback,
  taskUnits,
} from "~/lib/packing";
import { newClientSaleId } from "~/lib/pos-cart";
import { beep, wakeSound } from "~/lib/pos-device";
import { cn } from "~/lib/utils";
import type { PackTask, PackTaskLine } from "~/types/api";

export function meta() {
  return [{ title: "Pack order | Collabo CRM" }];
}

/**
 * Opens an order for packing: start returns its open task, its packed one if
 * it hasn't shipped since, or a new one. `?task=` shows a task without calling
 * start, so a packed parcel stays viewable after the order ships.
 */
export default function PackOrderPage() {
  const { orderId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const taskParam = searchParams.get("task");
  const queuePath = useListReturnPath("packing", "/orders/packing");

  const start = usePackingStart(orderId, !taskParam);
  const taskId = taskParam ?? start.data?.id;
  const taskQuery = usePackTask(taskId);
  const task = taskQuery.data;

  const failure = !taskParam && start.isError ? start.error : !task && taskQuery.isError ? taskQuery.error : null;
  if (failure) {
    const status = isAxiosError(failure) ? failure.response?.status : undefined;
    const refused = status === 409 || status === 404;
    return (
      <div className="py-16">
        <EmptyState
          icon={TriangleAlert}
          title={
            status === 403 ? "You can't pack orders" : refused ? "This order can't be packed" : "Couldn't open this order"
          }
          description={
            status === 403
              ? "You can see the queue, but packing needs a team member who can act on orders. Ask an admin."
              : serverMessage(failure, refused ? "It may have shipped or been cancelled." : "Check your connection and try again.")
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {!refused && status !== 403 && (
                <Button variant="outline" onClick={() => (taskParam ? taskQuery.refetch() : start.refetch())}>
                  Try again
                </Button>
              )}
              <Button asChild variant="outline">
                <Link to={queuePath}>Back to packing</Link>
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <PackScreen
      key={task.id}
      task={task}
      queuePath={queuePath}
      onStartAgain={() => (taskParam ? navigate(`/orders/packing/${orderId}`, { replace: true }) : void start.refetch())}
    />
  );
}

type OpenDialog =
  | { kind: "line"; mode: LineDialogMode; lineId: string }
  | { kind: "finish"; mode: "short" | "hold" }
  | { kind: "start-over" }
  | null;

function PackScreen({ task, queuePath, onStartAgain }: { task: PackTask; queuePath: string; onStartAgain: () => void }) {
  const [, setSearchParams] = useSearchParams();
  const phone = useMediaQuery("(max-width: 767px)");
  const actions = usePackTaskActions(task.id);
  const scanMutation = useScanMutation(task.id);

  const [feedback, setFeedback] = useState<ShownFeedback | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);

  const packing = task.status === "PACKING";
  const options = finishOptions(task);
  const { packed, required } = taskUnits(task.lines);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [flash]);
  useEffect(() => {
    if (!packing) setCameraOpen(false);
  }, [packing]);

  // ── Scanning. One request at a time, in the order the codes were read, so
  // a slow answer never paints over a newer one. ──
  const blockedRef = useRef(false);
  blockedRef.current = !packing || dialog !== null;
  const scanRef = useRef(scanMutation);
  scanRef.current = scanMutation;
  const chain = useRef<Promise<void>>(Promise.resolve());
  const scan = useCallback((raw: string) => {
    const code = raw.trim();
    if (!code || blockedRef.current) return;
    chain.current = chain.current.then(async () => {
      try {
        const res = await scanRef.current.mutateAsync({ code, clientScanId: newClientSaleId() });
        const fb = scanFeedback(res, code);
        beep(fb.sound === "ok");
        if (fb.vibrate) navigator.vibrate?.([120, 60, 120]);
        setFeedback({ tone: fb.tone, title: fb.title, detail: fb.detail, at: Date.now() });
        if (res.result === "matched" && res.lineId) setFlash(res.lineId);
      } catch (error) {
        beep(false);
        const unanswered = isAxiosError(error) && !error.response;
        setFeedback({
          tone: "danger",
          title: unanswered ? "That scan didn't reach Collabo" : serverMessage(error, "That scan wasn't counted"),
          detail: unanswered ? "Check the connection, then scan it again." : undefined,
          at: Date.now(),
        });
      }
    });
  }, []);
  useKeyboardWedge(scan, packing && dialog === null);

  const openCamera = () => {
    wakeSound();
    setCameraOpen(true);
  };

  // On a phone the camera covers the top half of the screen; push the page
  // down by whatever of that half the app bar doesn't already take.
  const topRef = useRef<HTMLDivElement>(null);
  const [panelGap, setPanelGap] = useState(0);
  useLayoutEffect(() => {
    if (!phone || !cameraOpen || !topRef.current) return;
    window.scrollTo({ top: 0 });
    setPanelGap(topRef.current.getBoundingClientRect().top);
  }, [phone, cameraOpen]);

  const say = (title: string, tone: ShownFeedback["tone"] = "success") => setFeedback({ tone, title, at: Date.now() });

  const onLineAction = (action: LineAction, line: PackTaskLine) => {
    const name = productName(line.title, line.variantTitle);
    if (action === "undo") {
      actions.undo.mutate(
        { lineId: line.id, clientScanId: newClientSaleId() },
        { onSuccess: () => say(`Took one ${name} out`, "warning") },
      );
    } else if (action === "clear-problem") {
      actions.clearProblem.mutate({ lineId: line.id }, { onSuccess: () => say(`Problem cleared on ${name}`) });
    } else {
      setDialog({ kind: "line", mode: action, lineId: line.id });
    }
  };

  const finish = () => {
    if (!options.allPacked) {
      setDialog({ kind: "finish", mode: "short" });
      return;
    }
    actions.finish.mutate("all", { onSuccess: packedDone });
  };
  const packedDone = () => {
    setDialog(null);
    toast.success(`${task.orderName} is packed and ready to ship.`);
    // From here the page shows this task; a reload must not start a new one.
    setSearchParams({ task: task.id }, { replace: true });
  };

  const dialogLine = dialog?.kind === "line" ? task.lines.find((l) => l.id === dialog.lineId) : undefined;
  const linePending =
    actions.confirm.isPending || actions.count.isPending || actions.reportProblem.isPending;

  const cameraFeedback: ScanFeedback | null = feedback
    ? { ok: feedback.tone === "success", warning: feedback.tone === "warning", text: feedback.title, at: feedback.at }
    : null;

  const customer = [firstName(task.customerName), task.city].filter(Boolean).join(" · ");
  // While the phone camera is up, only the result and the lines share the
  // half screen below it; the bar at the bottom carries the count.
  const scanning = phone && cameraOpen;
  const pct = required > 0 ? Math.round((packed / required) * 100) : 0;

  return (
    <div className="space-y-4">
      <div ref={topRef} />
      {phone && cameraOpen && <div aria-hidden style={{ height: `calc(50dvh - ${panelGap}px)` }} />}

      <nav aria-label="Breadcrumb" className={cn("flex items-center gap-1.5 text-caption", scanning && "hidden")}>
        <Link to={queuePath} className="text-muted-foreground hover:text-foreground">
          Packing
        </Link>
        <ChevronRight className="size-3 text-muted-foreground" />
        <span className="font-medium text-foreground">{task.orderName}</span>
      </nav>

      {/* Header: the order, who it's for, how it's paid. */}
      <header className={cn("rounded-xl bg-card p-4 ring-1 ring-border", scanning && "hidden")}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-subhead text-foreground">{task.orderName}</h1>
              <PackingBadges badges={paymentBadges(task)} />
            </div>
            {customer && <p className="text-body text-muted-foreground">For {customer}</p>}
            {task.warehouse && <p className="text-caption text-muted-foreground">Ships from {task.warehouse.name}</p>}
          </div>
          {(packing || task.status === "ON_HOLD") && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More for this order">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {packing && (
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "finish", mode: "hold" })}>
                    <CirclePause /> Put on hold
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "start-over" })}>
                  <RotateCcw /> Start over
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {task.payment === "cod" && task.codConfirmed === false && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-caption text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>Cash on delivery, and the customer hasn't confirmed this order yet. Check before it ships.</span>
          </p>
        )}
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section className="min-w-0 space-y-4" aria-label="Items">
          {task.status === "ON_HOLD" && (
            <div className="space-y-3 rounded-xl bg-warning-subtle p-4 ring-1 ring-warning/30">
              <p className="flex items-center gap-2 text-section text-foreground">
                <CirclePause className="size-5 shrink-0 text-warning" />
                On hold: {holdReasonLabel(task.holdReason).toLowerCase()}
              </p>
              {task.holdNote && <p className="text-body text-foreground [overflow-wrap:anywhere]">“{task.holdNote}”</p>}
              {task.heldAt && <p className="text-caption text-muted-foreground">Since {packedTime(task.heldAt)}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="accent"
                  className="h-11"
                  disabled={actions.resume.isPending}
                  onClick={() => actions.resume.mutate(undefined, { onSuccess: () => say("Back to packing. Scan the next item.") })}
                >
                  {actions.resume.isPending ? <Loader2 className="animate-spin" /> : <Play />} Resume packing
                </Button>
                <Button asChild variant="outline" className="h-11">
                  <Link to={queuePath}>Back to the queue</Link>
                </Button>
              </div>
            </div>
          )}
          {task.status === "PACKED" && (
            <div className="space-y-3 rounded-xl bg-success-subtle p-4 ring-1 ring-success/30">
              <p className="flex items-center gap-2 text-section text-foreground">
                <PackageCheck className="size-5 shrink-0 text-success" />
                Packed, ready to ship
              </p>
              <p className="text-body text-muted-foreground">
                {task.packedAt && `Packed ${packedTime(task.packedAt)}. `}
                {task.partial &&
                  `${packed} of ${itemsWord(required)} went in. The rest are packed after this parcel ships.`}
              </p>
              <Button asChild variant="accent" className="h-11">
                <Link to={queuePath}>Next order</Link>
              </Button>
            </div>
          )}
          {task.status === "CANCELLED" && (
            <div className="space-y-3 rounded-xl bg-muted p-4">
              <p className="text-section text-foreground">This packing was cleared</p>
              <Button variant="accent" className="h-11" onClick={onStartAgain}>
                Start packing again
              </Button>
            </div>
          )}

          <div className={cn("space-y-2 rounded-xl bg-card p-4 ring-1 ring-border", scanning && "hidden")}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-body text-muted-foreground">
                <span className="text-subhead tabular-nums text-foreground">{packed}</span> of {itemsWord(required)} packed
              </p>
              {options.allPacked && <span className="text-label text-success">All in</span>}
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Packed"
              aria-valuemin={0}
              aria-valuemax={required}
              aria-valuenow={packed}
            >
              <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>

          {packing && (
            <ScanBanner
              feedback={feedback}
              idle={phone ? "Tap Scan and point the camera at each item." : "Scan each item as it goes into the parcel."}
            />
          )}

          <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-border">
            {task.lines.map((line) => (
              <PackLine key={line.id} line={line} editable={packing} flash={flash === line.id} onAction={onLineAction} />
            ))}
          </ul>
        </section>

        {packing && !phone && (
          <aside className="space-y-4 md:order-first lg:order-none lg:sticky lg:top-6">
            <div className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-border">
              <h2 className="text-section text-foreground">Scan items</h2>
              {cameraOpen ? (
                <CameraScanner open variant="inline" onOpenChange={setCameraOpen} feedback={cameraFeedback} onCode={scan} />
              ) : (
                <>
                  <Button variant="outline" className="h-11 w-full" onClick={openCamera}>
                    <Camera /> Use the camera
                  </Button>
                  <TypedCode onCode={scan} />
                </>
              )}
              <p className="flex items-start gap-2 text-caption text-muted-foreground">
                <ScanBarcode className="mt-px size-3.5 shrink-0" />A USB or Bluetooth scanner works too: just scan.
              </p>
            </div>
            <div className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-border">
              <Button
                variant={options.allPacked ? "accent" : "brand"}
                className="h-11 w-full text-section"
                disabled={actions.finish.isPending}
                onClick={finish}
              >
                {actions.finish.isPending && <Loader2 className="animate-spin" />}
                {options.allPacked ? "Mark packed" : "Finish packing"}
              </Button>
              {!options.allPacked && (
                <p className="text-caption text-muted-foreground">
                  {itemsWord(required - packed)} still to pack. Finishing now lets you hold the order.
                </p>
              )}
            </div>
          </aside>
        )}
      </div>

      {packing && phone && (
        <div className="mobile-action-dock sticky z-30 -mx-4 flex items-center gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur">
          <p className="min-w-0 flex-1 text-label tabular-nums">
            {packed} of {required} packed
          </p>
          <Button variant="outline" className="h-11" onClick={() => (cameraOpen ? setCameraOpen(false) : openCamera())}>
            <Camera /> {cameraOpen ? "Close" : "Scan"}
          </Button>
          <Button
            variant={options.allPacked ? "accent" : "brand"}
            className="h-11"
            disabled={actions.finish.isPending}
            onClick={finish}
          >
            {actions.finish.isPending && <Loader2 className="animate-spin" />}
            {options.allPacked ? "Mark packed" : "Finish"}
          </Button>
        </div>
      )}

      {phone && (
        <CameraScanner open={cameraOpen} variant="panel" onOpenChange={setCameraOpen} feedback={cameraFeedback} onCode={scan} />
      )}

      {dialog?.kind === "line" && dialogLine && (
        <LineDialog
          mode={dialog.mode}
          line={dialogLine}
          pending={linePending}
          onClose={() => setDialog(null)}
          onConfirm={(qty, reason) =>
            actions.confirm.mutate(
              { lineId: dialogLine.id, qty, reason, clientScanId: newClientSaleId() },
              {
                onSuccess: () => {
                  setDialog(null);
                  say(`${productName(dialogLine.title, dialogLine.variantTitle)}: ${qty} confirmed by hand`);
                },
              },
            )
          }
          onCount={(count) =>
            actions.count.mutate(
              { lineId: dialogLine.id, packed: count, clientScanId: newClientSaleId() },
              {
                onSuccess: () => {
                  setDialog(null);
                  say(`${productName(dialogLine.title, dialogLine.variantTitle)}: ${count} of ${dialogLine.required} packed`);
                },
              },
            )
          }
          onProblem={(reason, qty) =>
            actions.reportProblem.mutate(
              { lineId: dialogLine.id, reason, qty },
              {
                onSuccess: () => {
                  setDialog(null);
                  say(`Problem noted on ${productName(dialogLine.title, dialogLine.variantTitle)}`, "warning");
                },
              },
            )
          }
        />
      )}
      {dialog?.kind === "finish" && (
        <FinishDialog
          mode={dialog.mode}
          options={options}
          shortLines={task.lines.filter((l) => l.packed < l.required)}
          pending={actions.hold.isPending || actions.finish.isPending}
          onClose={() => setDialog(null)}
          onHold={(reason, note) =>
            actions.hold.mutate(
              { reason, note },
              {
                onSuccess: () => {
                  setDialog(null);
                  toast.success(`${task.orderName} is on hold.`);
                },
              },
            )
          }
          onPartial={() => actions.finish.mutate("partial", { onSuccess: packedDone })}
        />
      )}
      {dialog?.kind === "start-over" && (
        <StartOverDialog
          packedUnits={packed}
          pending={actions.cancel.isPending}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            actions.cancel.mutate(undefined, {
              onSuccess: () => {
                setDialog(null);
                onStartAgain();
              },
            })
          }
        />
      )}
    </div>
  );
}

/** For a code a scanner can't read: the printed digits, or the SKU. */
function TypedCode({ onCode }: { onCode: (code: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onCode(value);
        setValue("");
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Or type the barcode or SKU"
        aria-label="Barcode or SKU"
        autoComplete="off"
        className="h-11"
      />
      <Button type="submit" variant="outline" className="h-11" disabled={!value.trim()}>
        Add
      </Button>
    </form>
  );
}
