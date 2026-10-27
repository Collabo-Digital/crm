import { useRef, useState, type ReactNode } from "react";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface ImageUploadProps {
  id: string;
  /** What the image is, lowercase: "logo", "signature". */
  noun: string;
  /** The image as the app shows it now, or null when there is none. */
  imageUrl: string | null;
  maxBytes: number;
  /** Narrower images print blurred, so they are refused here before upload. */
  minWidth?: number;
  hint: ReactNode;
  readOnly: boolean;
  busy: "uploading" | "removing" | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
  className?: string;
}

const SIZE = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

/**
 * A logo or signature upload. It saves at once, apart from the form's Save.
 * The server checks the file's first bytes and its size; the same limits are
 * checked here first, so a wrong file is explained before it is sent.
 */
export function ImageUpload({ id, noun, imageUrl, maxBytes, minWidth, hint, readOnly, busy, onUpload, onRemove, className }: ImageUploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  async function choose(file: File) {
    setProblem(null);
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      setProblem("Choose a PNG or JPG file.");
      return;
    }
    if (file.size > maxBytes) {
      setProblem(`This file is ${SIZE(file.size)}. Choose one up to ${SIZE(maxBytes)}.`);
      return;
    }
    if (minWidth) {
      const width = await createImageBitmap(file).then(
        (bitmap) => {
          const w = bitmap.width;
          bitmap.close();
          return w;
        },
        () => null,
      );
      if (width === null) {
        setProblem("This file couldn't be opened as an image.");
        return;
      }
      if (width < minWidth) {
        setProblem(`This ${noun} is ${width} px wide. Choose one at least ${minWidth} px wide, so it prints sharply.`);
        return;
      }
    }
    setBroken(false);
    onUpload(file);
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid h-16 w-40 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted/40">
          {imageUrl && !broken ? (
            <img src={imageUrl} alt={`Your ${noun}`} className="max-h-14 max-w-36 object-contain" onError={() => setBroken(true)} />
          ) : (
            <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
              <ImageIcon className="size-4" />
              {imageUrl ? "Can't show it" : `No ${noun} yet`}
            </span>
          )}
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              id={id}
              type="file"
              accept="image/png,image/jpeg"
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void choose(file);
              }}
            />
            <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => input.current?.click()}>
              {busy === "uploading" ? <Loader2 className="animate-spin" /> : <Upload />}
              {imageUrl ? "Replace" : `Upload ${noun}`}
            </Button>
            {imageUrl && (
              <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={onRemove}>
                {busy === "removing" ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      {problem && (
        <p role="alert" className="text-micro text-danger">
          {problem}
        </p>
      )}
      <p className="text-micro text-muted-foreground">{hint}</p>
    </div>
  );
}
