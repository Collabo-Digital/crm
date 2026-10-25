import { useEffect, useRef, useState } from "react";
import { CameraOff, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";

// Retail barcodes, plus QR for codes printed by the label sheets.
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];
// getUserMedia can wait forever for a permission prompt nobody answers, or on
// a device with no camera at all.
const CAMERA_TIMEOUT_MS = 10_000;

interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};

/**
 * Reads a barcode with the device camera. Uses the browser's own
 * BarcodeDetector where there is one (Chrome on Android, macOS), otherwise
 * loads ZXing on first use. When no camera opens, the code can be typed.
 */
export function CameraScanner({ open, onOpenChange, onCode }: { open: boolean; onOpenChange: (open: boolean) => void; onCode: (code: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scan with the camera</DialogTitle>
          <DialogDescription>Hold the barcode inside the frame. The item is added as soon as it is read.</DialogDescription>
        </DialogHeader>
        {open && <CameraView onCode={onCode} />}
      </DialogContent>
    </Dialog>
  );
}

function CameraView({ onCode }: { onCode: (code: string) => void }) {
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
    const report = (code: string) => {
      if (found || stopped || !code) return;
      found = true;
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
          else setTimeout(loop, 150);
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
  }, []);

  return (
    <div className="space-y-3">
      {state === "failed" ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-muted p-6 text-center">
          <CameraOff className="size-6 text-muted-foreground" />
          <p className="text-caption text-muted-foreground">{failure}</p>
        </div>
      ) : (
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} muted playsInline className="size-full object-cover" />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-white/80" />
          {state === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-caption text-white">
              <Loader2 className="size-4 animate-spin" /> Opening the camera…
            </div>
          )}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) onCode(typed.trim());
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
