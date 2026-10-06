import { toast } from "sonner";

/**
 * Fetch a Blob and save it, surfacing failures as a toast rather than silence.
 *
 * One copy, three consumers. This lived as a private helper in
 * `routes/app/orders.tsx` and again, near-identically, in
 * `routes/app/orders/invoices.tsx` — the invoices copy also had to thread an
 * `isDownloading` flag through by hand. Import this instead of writing a fourth.
 */
export async function downloadBlob(
  fetchBlob: () => Promise<Blob>,
  filename: string,
  errorMessage: string,
): Promise<void> {
  let objectUrl: string | null = null;
  try {
    const blob = await fetchBlob();
    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    // In the document for the click: Chrome saves from a detached anchor,
    // WebKit has not always.
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    toast.error(errorMessage);
  } finally {
    // Revoked on a timer, not inline. Chrome has started the save by the time
    // click() returns, but Firefox and Safari start it on a later task, and
    // revoking the URL before then cancels the download silently — no file,
    // no error, no toast. Still `finally` so a click() that throws cannot
    // leak the object URL for the lifetime of the document.
    if (objectUrl) {
      // Copied so the closure holds a `string`; the `let` above narrows only
      // inside this block.
      const urlToRevoke = objectUrl;
      setTimeout(() => URL.revokeObjectURL(urlToRevoke), REVOKE_DELAY_MS);
    }
  }
}

/** Long enough for every browser to have opened the blob; nothing waits on it. */
const REVOKE_DELAY_MS = 1_000;
