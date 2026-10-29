import { ExternalLink, FileText, Image, MapPin, Phone, Reply, Video } from "lucide-react";

import { cn } from "~/lib/utils";
import type { TemplateRender } from "~/types/api";

const HEADER_ICON = { IMAGE: Image, VIDEO: Video, DOCUMENT: FileText, LOCATION: MapPin } as const;

/** A variable still showing as {{…}}: unmapped values are made obvious, never blanked. */
function withPlaceholders(text: string) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) =>
    /^\{\{[^}]+\}\}$/.test(part) ? (
      <span key={i} className="rounded bg-warning-subtle px-0.5 font-medium text-warning-strong">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * How a template lands in WhatsApp, approximately: header, body, footer and
 * buttons in one bubble. Deliberately not WhatsApp's own colours — this is a
 * preview inside the CRM, not a conversation.
 */
export function TemplatePreview({
  render,
  mediaUrl,
  buttonKinds,
  className,
}: {
  render: TemplateRender;
  /** A local preview of the header file, when one is chosen. */
  mediaUrl?: string | null;
  /** Per button, for its icon: QUICK_REPLY, URL, PHONE_NUMBER, COPY_CODE. */
  buttonKinds?: string[];
  className?: string;
}) {
  const format = render.headerFormat as keyof typeof HEADER_ICON | "TEXT" | null;
  const HeaderIcon = format && format !== "TEXT" ? HEADER_ICON[format] : null;

  return (
    <div className={cn("w-full max-w-sm", className)}>
      <div className="overflow-hidden rounded-xl rounded-tl-sm bg-muted text-foreground shadow-sm">
        {HeaderIcon &&
          (mediaUrl && format === "IMAGE" ? (
            <img src={mediaUrl} alt="" className="max-h-48 w-full object-cover" />
          ) : (
            <div className="flex h-28 items-center justify-center bg-foreground/5 text-muted-foreground">
              <HeaderIcon className="size-7" />
            </div>
          ))}
        <div className="space-y-1.5 px-3.5 py-3">
          {render.header && <p className="text-body font-semibold">{withPlaceholders(render.header)}</p>}
          <p className="whitespace-pre-wrap break-words text-body">{render.body ? withPlaceholders(render.body) : <span className="text-muted-foreground">Message body</span>}</p>
          {render.footer && <p className="text-micro text-muted-foreground">{render.footer}</p>}
        </div>
        {render.buttons.length > 0 && (
          <div className="divide-y border-t border-foreground/10">
            {render.buttons.slice(0, 3).map((label, i) => {
              const kind = buttonKinds?.[i];
              const Icon = kind === "URL" ? ExternalLink : kind === "PHONE_NUMBER" ? Phone : kind === "COPY_CODE" ? FileText : Reply;
              return (
                <p key={i} className="flex items-center justify-center gap-1.5 py-2 text-caption font-medium text-info">
                  <Icon className="size-3.5" />
                  {label}
                </p>
              );
            })}
            {render.buttons.length > 3 && (
              <p className="py-2 text-center text-caption font-medium text-info">See all options</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
