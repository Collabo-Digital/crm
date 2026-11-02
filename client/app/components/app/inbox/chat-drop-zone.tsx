import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Package, Paperclip } from "lucide-react";

import { cn } from "~/lib/utils";

import { PRODUCTS_DRAG_TYPE, type CatalogDrop } from "./catalog-panel";

type DragKind = "catalog" | "file";

function kindOf(event: DragEvent): DragKind | null {
  const types = event.dataTransfer.types;
  if (types.includes(PRODUCTS_DRAG_TYPE)) return "catalog";
  if (types.includes("Files")) return "file";
  return null;
}

/**
 * The conversation as a drop target: products and collections dragged from
 * the catalog panel, and a file dragged in from the computer, go into the
 * reply. Nothing is sent until the teammate presses Send.
 */
export function ChatDropZone({
  disabled,
  onCatalog,
  onFile,
  className,
  children,
}: {
  disabled: boolean;
  onCatalog: (drop: CatalogDrop) => void;
  onFile: (file: File) => void;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState<DragKind | null>(null);
  // dragenter and dragleave fire for every child crossed; count to know when the pointer really left.
  const depth = useRef(0);

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(event) => {
        const kind = kindOf(event);
        if (!kind || disabled) return;
        event.preventDefault();
        depth.current += 1;
        setOver(kind);
      }}
      onDragOver={(event) => {
        if (!kindOf(event) || disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (!over) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(null);
      }}
      onDrop={(event) => {
        const kind = kindOf(event);
        depth.current = 0;
        setOver(null);
        if (!kind || disabled) return;
        event.preventDefault();
        if (kind === "file") {
          const file = event.dataTransfer.files[0];
          if (file) onFile(file);
          return;
        }
        try {
          onCatalog(JSON.parse(event.dataTransfer.getData(PRODUCTS_DRAG_TYPE)) as CatalogDrop);
        } catch {
          // Not a drag from the panel after all.
        }
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand bg-card/90 p-6 text-center backdrop-blur-sm">
          {over === "catalog" ? <Package className="size-6 text-brand-strong" /> : <Paperclip className="size-6 text-brand-strong" />}
          <p className="text-body font-medium">{over === "catalog" ? "Drop to add it to your reply" : "Drop to attach the file"}</p>
          <p className="text-micro text-muted-foreground">
            {over === "catalog" ? "It goes out when you press Send." : "One file a message: an image, a video, a PDF or a document."}
          </p>
        </div>
      )}
    </div>
  );
}
