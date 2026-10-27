import { useEffect, useRef, useState, type ReactNode } from "react";
import { CameraOff, Loader2, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

// Retail barcodes, plus QR for codes printed by the label sheets.
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];
// getUserMedia can wait forever for a permission prompt nobody answers, or on
// a device with no camera at all.
const CAMERA_TIMEOUT_MS = 10_000;
// While scanning one item after another, the same code held in view is read
// many times a second: it counts once per this long, and any code once per
// SETTLE_MS so the next item can be brought in.
const SAME_CODE_MS = 2_000;
const SETTLE_MS = 800;

interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};

export interface ScanFeedback {
  ok: boolean;
  text: string;
  at: number;
  /** A not-ok result that is only a warning: amber rather than red. */
  warning?: boolean;
}

/**
 * Reads a barcode with the device camera. Uses the browser's own
 * BarcodeDetector where there is one (Chrome on Android, macOS), otherwise
 * loads ZXing on first use. When no camera opens, the code can be typed.
 *
 * On a phone it is a panel over the top half of the till that keeps scanning,
 * so the list and the bottom bar stay in view; elsewhere a dialog that closes
 * after one code. `inline` keeps scanning inside the page's own column, for a
 * desk where one order takes many scans.
 */
export function CameraScanner({
  open,
  onOpenChange,
  onCode,
  variant,
  feedback,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCode: (code: string) => void;
  variant: "dialog" | "panel" | "inline";
  /** The last scan's result, shown on the panel. */
  feedback: ScanFeedback | null;
}) {
  const overlay = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Close the camera"
        onClick={() => onOpenChange(false)}
        className="absolute top-2 right-2 size-11 rounded-full bg-black/50 text-white hover:bg-black/70 hover:text-white"
      >
        <X />
      </Button>
      <p
        key={feedback?.at ?? 0}
        role="status"
        className={cn(
          "absolute inset-x-3 bottom-3 mx-auto w-fit max-w-full truncate rounded-full px-3 py-1.5 text-caption font-medium animate-in fade-in-0",
          !feedback
            ? "bg-black/60 text-white"
            : feedback.ok
              ? "bg-success text-white"
              : feedback.warning
                ? "bg-warning text-ink"
                : "bg-danger text-white",
        )}
      >
        {feedback?.text ?? "Point the camera at a barcode. Each one is added as it is read."}
      </p>
    </>
  );
  if (variant === "panel") {
    if (!open) return null;
    return (
      <div
        role="region"
        aria-label="Camera scanner"
        className="fixed inset-x-0 top-0 z-40 flex h-[50dvh] flex-col bg-black pt-[env(safe-area-inset-top)] shadow-2xl animate-in slide-in-from-top-4 fade-in-0"
      >
        <CameraView continuous onCode={onCode} className="min-h-0 flex-1" overlay={overlay} />
      </div>
    );
  }
  if (variant === "inline") {
    if (!open) return null;
    return (
      <div role="region" aria-label="Camera scanner" className="overflow-hidden rounded-xl ring-1 ring-border">
        <CameraView continuous onCode={onCode} className="aspect-[4/3]" overlay={overlay} />
      </div>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scan with the camera</DialogTitle>
          <DialogDescription>Hold the barcode inside the frame. The item is added as soon as it is read.</DialogDescription>
        </DialogHeader>
        {open && <CameraView onCode={onCode} className="aspect-[4/3] rounded-xl" />}
      </DialogContent>
    </Dialog>
  );
}

function CameraView({
  onCode,
  continuous = false,
  className,
  overlay,
}: {
  onCode: (code: string) => void;
  continuous?: boolean;
  className?: string;
  overlay?: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"starting" | "scanning" | "failed">("starting");
  const [failure, setFailure] = useState("");
  const [typed, setTyped] = useState("");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopDecoder: (() => void) | undefined;
    let found = false;
    let last = { code: "", at: 0 };
    const report = (code: string) => {
      if (stopped || !code || found) return;
      const now = performance.now();
      if (continuous) {
        if (now - last.at < SETTLE_MS || (code === last.code && now - last.at < SAME_CODE_MS)) return;
        last = { code, at: now };
      } else {
        found = true;
      }
      onCodeRef.current(code);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use a camera here. Type the code instead.");
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The camera did not open. Allow camera access, or type the code instead.")), CAMERA_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
      const video = videoRef.current;
      // Closed while the camera was opening: the cleanup below already ran.
      if (stopped || !video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      setState("scanning");

      const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
      const supported = Native ? await Native.getSupportedFormats().catch(() => []) : [];
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (Native && formats.length) {
        const detector = new Native({ formats });
        const loop = async () => {
          if (stopped || found) return;
          const codes = await detector.detect(video).catch(() => []);
          if (codes[0]) report(codes[0].rawValue);
          setTimeout(loop, 150);
        };
        void loop();
        return;
      }

      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
        import("@zxing/browser"),
        import("@zxing/library"),
      ]);
      if (stopped) return;
      const hints = new Map([
        [
          DecodeHintType.POSSIBLE_FORMATS,
          [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE],
        ],
      ]);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
      const controls = await reader.decodeFromVideoElement(video, (result) => {
        if (result) report(result.getText());
      });
      if (stopped) controls.stop();
      else stopDecoder = () => controls.stop();
    })().catch((error: unknown) => {
      if (stopped) return;
      setFailure(error instanceof Error && error.name !== "NotAllowedError" ? error.message : "Camera access was refused. Allow it in the browser's site settings, or type the code instead.");
      setState("failed");
    });

    return () => {
      stopped = true;
      clearTimeout(timer);
      stopDecoder?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [continuous]);

  return (
    <div className={cn("flex flex-col", continuous ? "min-h-0 flex-1" : "gap-3")}>
      {state === "failed" ? (
        <div className={cn("relative flex flex-col items-center justify-center gap-2 bg-muted p-6 text-center", className)}>
          <CameraOff className="size-6 text-muted-foreground" />
          <p className="text-caption text-muted-foreground">{failure}</p>
          {overlay}
        </div>
      ) : (
        <div className={cn("relative overflow-hidden bg-black", className)}>
          <video ref={videoRef} muted playsInline className="size-full object-cover" />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-white/80" />
          {state === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-caption text-white">
              <Loader2 className="size-4 animate-spin" /> Opening the camera…
            </div>
          )}
          {overlay}
        </div>
      )}
      <form
        className={cn("flex gap-2", continuous && "bg-background p-2")}
        onSubmit={(e) => {
          e.preventDefault();
          if (!typed.trim()) return;
          onCode(typed.trim());
          setTyped("");
        }}
      >
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type the barcode or SKU" aria-label="Barcode or SKU" autoComplete="off" className="h-11" />
        <Button type="submit" variant="outline" className="h-11" disabled={!typed.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}
