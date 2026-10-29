import { useCallback, useEffect, useRef, useState } from "react";
import type { default as ReactQuillType } from "react-quill-new";
import "quill/dist/quill.snow.css";

const EMPTY_QUILL_HTML = new Set(["", "<p><br></p>", "<p></p>", "<br>"]);

/** Treat Quill's empty-document markup as blank for dirty/save comparisons. */
export function normalizeBodyHtml(html: string): string {
  const trimmed = html.trim();
  if (!trimmed || EMPTY_QUILL_HTML.has(trimmed)) return "";

  if (typeof DOMParser === "undefined") return trimmed;

  const doc = new DOMParser().parseFromString(trimmed, "text/html");
  const strip = (el: Element) => {
    el.removeAttribute("class");
    el.removeAttribute("contenteditable");
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("data-")) el.removeAttribute(attr.name);
    }
    const style = el.getAttribute("style");
    if (style != null && !style.trim()) el.removeAttribute("style");
    for (const child of el.children) strip(child);
  };
  for (const el of doc.body.children) strip(el);

  const result = doc.body.innerHTML.trim();
  if (!result || EMPTY_QUILL_HTML.has(result)) return "";
  return result;
}

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  /** Fired once after Quill mounts so the parent can sync its dirty baseline. */
  onEditorReady?: (stableValue: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
};

const TOOLBAR_MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ list: "ordered" }, { list: "bullet" }],
    // "image" is intentionally omitted: Quill's default handler base64-embeds
    // files straight into the stored HTML.
    ["link"],
    ["clean"],
  ],
};

export function RichTextEditor({
  value,
  onChange,
  onEditorReady,
  placeholder = "Write a description…",
  readOnly = false,
  className,
}: RichTextEditorProps) {
  const [ReactQuill, setReactQuill] = useState<typeof ReactQuillType | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const readyNotifiedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    import("react-quill-new")
      .then((mod) => {
        if (!cancelled) setReactQuill(() => mod.default);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const notifyReady = useCallback(
    (stableValue: string) => {
      if (readyNotifiedRef.current) return;
      readyNotifiedRef.current = true;
      onEditorReady?.(stableValue);
    },
    [onEditorReady],
  );

  const handleChange = useCallback(
    (next: string) => {
      // Quill normalizes "" to "<p><br></p>" on mount — ignore no-op updates.
      if (normalizeBodyHtml(next) === normalizeBodyHtml(value)) {
        notifyReady(next);
        return;
      }
      onChange(next);
      notifyReady(next);
    },
    [value, onChange, notifyReady],
  );

  useEffect(() => {
    if (!ReactQuill) return;
    const frame = requestAnimationFrame(() => notifyReady(value));
    return () => cancelAnimationFrame(frame);
  }, [ReactQuill, value, notifyReady]);

  useEffect(() => {
    if (loadFailed) notifyReady(value);
  }, [loadFailed, value, notifyReady]);

  if (loadFailed) {
    return (
      <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-input bg-muted/30 text-xs text-muted-foreground">
        Editor failed to load. Refresh the page to try again.
      </div>
    );
  }

  if (!ReactQuill) {
    return (
      <div className="min-h-[120px] animate-pulse rounded-lg border border-input bg-muted/30" />
    );
  }

  return (
    <ReactQuill
      // Quill gives its text-style picker no name of its own.
      ref={(editor) => {
        editor?.getEditor().container.parentElement
          ?.querySelector(".ql-header .ql-picker-label")
          ?.setAttribute("aria-label", "Text style");
      }}
      theme="snow"
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      readOnly={readOnly}
      modules={TOOLBAR_MODULES}
      className={className}
    />
  );
}
