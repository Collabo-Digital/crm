import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Skeleton } from "~/components/ui/skeleton";

/**
 * A UPI QR code the customer scans with any UPI app. Drawn in the browser
 * with the same library the server uses for chat-link QR codes, because the
 * amount changes with every bill. Always dark on white: UPI apps misread an
 * inverted code.
 */
export function UpiQr({ uri, label }: { uri: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 400, color: { dark: "#000000", light: "#ffffff" } }).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [uri]);
  return src ? (
    <img src={src} alt={label} className="size-48 rounded-lg bg-white" />
  ) : (
    <Skeleton className="size-48" />
  );
}
