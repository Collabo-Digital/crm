import { useEffect, useRef, useState } from "react";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFWorker, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";

import { Skeleton } from "~/components/ui/skeleton";
import { useDebounced } from "~/hooks/use-debounced";
import { cn } from "~/lib/utils";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * pdf.js and one worker for the whole app, fetched the first time a PDF is
 * drawn, so only the pages that draw one pay for it. The legacy build,
 * because pdf.js's default build needs Safari 17.4; this one runs from
 * Safari 16.4 and Chrome 118.
 *
 * The worker script is fetched before pdf.js is asked to start it: a worker
 * pdf.js fails to start leaves it broken until the page reloads, while a
 * failed fetch here (offline) is simply tried again next time.
 */
let loaded: Promise<{ pdfjs: PdfJs; worker: PDFWorker }> | null = null;

function loadPdfJs() {
  loaded ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    fetch(workerSrc).then((response) => {
      if (!response.ok) throw new Error(`The PDF worker could not be loaded (${response.status}).`);
      return response.arrayBuffer();
    }),
  ]).then(
    ([pdfjs]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      return { pdfjs, worker: new pdfjs.PDFWorker() };
    },
    (error: unknown) => {
      loaded = null;
      throw error;
    },
  );
  return loaded;
}

/** Frees a canvas's memory now; Safari on iPhone caps the total and frees it lazily. */
function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

/** Print resolution: pdf.js measures pages in points, 72 to the inch. */
const PRINT_SCALE = 300 / 72;
/** Safari on iPhone refuses a canvas above about 16.7 million pixels. */
const MAX_CANVAS_PIXELS = 16_000_000;

interface PdfPagesProps {
  /** The PDF. A new one is drawn off screen and swapped in, so the old pages stay until it is ready. */
  data: ArrayBuffer | undefined;
  /** Names the document for screen readers, like "Invoice INV-26-27/000124". */
  label: string;
  /**
   * `screen` fits each page to the container's width. `print` draws each page
   * at 300 dpi into an image of its paper size, for the browser to print.
   */
  mode?: "screen" | "print";
  /** After every page of a file is drawn. */
  onRendered?: (pageCount: number) => void;
  /** When a file cannot be drawn. */
  onError?: (error: unknown) => void;
  className?: string;
}

/**
 * A PDF drawn with pdf.js: the invoice settings preview, the invoice page and
 * its print view all show the server's own PDF through this, so what is on
 * screen is the file customers get.
 */
export function PdfPages({ data, label, mode = "screen", onRendered, onError, className }: PdfPagesProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onRendered, onError });
  callbacks.current = { onRendered, onError };
  const shownUrls = useRef<string[]>([]);
  const [drawn, setDrawn] = useState(false);

  // Screen mode draws at the container's width, so a resize redraws, once it settles.
  const [width, setWidth] = useState(0);
  const drawWidth = useDebounced(width, 150);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || mode !== "screen") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(host);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !data || (mode === "screen" && drawWidth === 0)) return;
    let cancelled = false;
    let shown = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let renderTask: RenderTask | null = null;
    const urls: string[] = [];
    const canvases: HTMLCanvasElement[] = [];

    (async () => {
      const { pdfjs, worker } = await loadPdfJs();
      if (cancelled) return;
      loadingTask = pdfjs.getDocument({
        // pdf.js hands the bytes to its worker, which empties the buffer; the cached file must survive.
        data: new Uint8Array(data.slice(0)),
        worker,
        isOffscreenCanvasSupported: typeof OffscreenCanvas !== "undefined",
      });
      const pdf = await loadingTask.promise;
      const pages: HTMLElement[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        if (cancelled) return;
        const paper = page.getViewport({ scale: 1 });
        const wanted = mode === "print" ? PRINT_SCALE : (drawWidth / paper.width) * (window.devicePixelRatio || 1);
        const fit = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (paper.width * paper.height * wanted * wanted)));
        const viewport = page.getViewport({ scale: wanted * fit });
        const canvas = document.createElement("canvas");
        canvases.push(canvas);
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
        renderTask = null;
        page.cleanup();
        if (cancelled) return;

        const pageLabel = `Page ${number} of ${pdf.numPages}`;
        if (mode === "print") {
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          release(canvas);
          if (!blob) throw new Error("A page could not be prepared for printing.");
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const image = document.createElement("img");
          image.src = url;
          image.alt = pageLabel;
          image.className = "pdf-print-page block bg-white";
          image.style.width = `${(paper.width * 25.4) / 72}mm`;
          image.style.height = `${(paper.height * 25.4) / 72}mm`;
          await image.decode();
          pages.push(image);
        } else {
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", pageLabel);
          canvas.className = "block h-auto w-full bg-white shadow-sm ring-1 ring-border";
          pages.push(canvas);
        }
      }
      await pdf.destroy();
      if (cancelled) return;
      const previous = [...host.querySelectorAll("canvas")];
      host.replaceChildren(...pages);
      shown = true;
      previous.forEach(release);
      shownUrls.current.forEach((url) => URL.revokeObjectURL(url));
      shownUrls.current = urls;
      setDrawn(true);
      callbacks.current.onRendered?.(pages.length);
    })()
      .catch((error: unknown) => {
        if (!cancelled) callbacks.current.onError?.(error);
      })
      .finally(() => {
        // A run that was overtaken or failed keeps nothing it made.
        if (shown) return;
        urls.forEach((url) => URL.revokeObjectURL(url));
        canvases.forEach(release);
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      void loadingTask?.destroy();
    };
  }, [data, drawWidth, mode]);

  useEffect(() => {
    const host = hostRef.current;
    return () => {
      host?.querySelectorAll("canvas").forEach(release);
      shownUrls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  return (
    <div role="group" aria-label={label} className={className}>
      {!drawn && mode === "screen" && <Skeleton className="aspect-[210/297] w-full" />}
      <div ref={hostRef} className={cn("space-y-4", mode === "print" && "space-y-0")} />
    </div>
  );
}
