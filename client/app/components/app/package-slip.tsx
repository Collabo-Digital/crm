import { useLayoutEffect, useRef } from "react";
import { Flame, Mail, MessageCircle, Phone, Recycle, Umbrella } from "lucide-react";
import { BarcodeSvg } from "~/components/app/labels/label-artwork";
import { readAddress } from "~/lib/address";
import { planBarcode } from "~/lib/barcode";
import { SLIP_REF_W_MM } from "~/lib/slip-stock";
import type { OrderSlipData } from "~/types/api";

/**
 * The printed package slip — the branded "PACKAGE SLIP" layout.
 *
 * PRESENTATIONAL ONLY: no hooks that fetch, no router, no query. Both print
 * paths (the per-order `/orders/:id/packing-slip` and the batch
 * `/orders/slips/print`) render THIS component, so a slip printed one at a
 * time and a slip printed 4-up are the same artwork. Data resolution — store
 * profile, warehouse and GSTIN fallbacks — happens in the routes, which is why
 * this takes an already-resolved `store`.
 *
 * SIZE INDEPENDENCE: every dimension derives from `scale` (see
 * `slipScale` in `~/lib/slip-stock`), which reports how much bigger the chosen
 * stock is than the 100 × 150 mm reference box. Type goes through `pt()` and
 * structural spacing through `mm()`. There is deliberately no per-size branch:
 * one design, six stocks.
 */

/** The merchant's identity, already resolved through its fallback chain. */
export interface PackageSlipStore {
  name: string;
  /** Display-ready lines from `readAddress().lines`, or a manual equivalent. */
  addressLines: string[];
  phone: string;
  whatsapp: string;
  email: string;
  website: string;
  logoUrl: string;
}

export interface PackageSlipProps {
  order: OrderSlipData;
  store: PackageSlipStore;
  /** From `slipScale(profile)`. 1.0 at 100 × 150 mm. */
  scale: number;
  /**
   * Reserve the blank strip captioned "Barcode :". It is intentionally EMPTY —
   * that space is where the courier's own shipping label gets stuck, so
   * printing our own symbol there would be covered up. The order's own
   * barcode (for the packing screen) sits under the brand row instead.
   */
  showBarcodeZone?: boolean;
  /**
   * The slip's printable width in mm, which the order barcode must fit. The
   * reference box at this scale when not given.
   */
  contentWidthMm?: number;
  /** Optional contents list. Off by default — the reference design has none. */
  showItems?: boolean;
  /**
   * Editor preview only: mark where an optional zone sits while its checkbox
   * row is hovered. The print sheet never passes it, so nothing here can reach
   * paper.
   */
  highlight?: SlipZone | null;
}

/** The optional zones a merchant can switch on and off. */
export type SlipZone = "barcode" | "items";

/** Warm dark used for the header band and the care tiles. */
const INK = "#3f3a35";

/**
 * Inset, so the slip root's `overflow: hidden` cannot clip the sides. An
 * outline and a background only — neither takes part in layout, so hovering
 * cannot move anything or change what AutoFitText measures.
 */
const HIGHLIGHT: React.CSSProperties = {
  outline: "2px solid #94E802",
  outlineOffset: "-2px",
  background: "rgba(206, 241, 123, 0.35)",
};

/**
 * Shrink text until it stops overflowing its box.
 *
 * The merchant's own printed sample had the recipient's address cut off
 * mid-line — a long Indian address simply does not fit a fixed size in an A6
 * quadrant. Measuring is reliable here for the same reason the rest of this
 * file works: the box is sized in millimetres, so the element measured on
 * screen is the element that prints.
 *
 * Steps the font down to a floor rather than shrinking without limit — below
 * that an address is unreadable, and clipping the last line is the better
 * failure. Writes `style.fontSize` directly instead of through state: this
 * runs in layout, and a setState round-trip per step would thrash a page of
 * 100 slips.
 */
function AutoFitText({
  basePt,
  minRatio = 0.65,
  className,
  children,
  fitKey,
}: {
  basePt: number;
  minRatio?: number;
  className?: string;
  children: React.ReactNode;
  /** Re-run the fit when the content or the target size changes. */
  fitKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const floor = basePt * minRatio;
    const step = basePt * 0.05;
    let pt = basePt;
    el.style.fontSize = `${pt}pt`;
    // +0.5 tolerance: sub-pixel rounding makes scrollHeight exceed clientHeight
    // by a fraction on boxes that actually fit, which would shrink every slip.
    while (el.scrollHeight > el.clientHeight + 0.5 && pt > floor) {
      pt = Math.max(floor, pt - step);
      el.style.fontSize = `${pt}pt`;
    }
  }, [basePt, minRatio, fitKey]);

  return (
    <div ref={ref} className={className} style={{ height: "100%", overflow: "hidden" }}>
      {children}
    </div>
  );
}

/** One dark tile in the "Handle With Care" row. */
function CareTile({
  icon,
  caption,
  pt,
  mm,
}: {
  icon: React.ReactNode;
  caption: string;
  pt: (n: number) => string;
  mm: (n: number) => string;
}) {
  return (
    <div style={{ textAlign: "center", flex: 1, minWidth: 0 }}>
      <div
        style={{
          background: INK,
          color: "#fff",
          borderRadius: mm(0.8),
          padding: mm(1.4),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // print-color-adjust is set on the cell by the print routes; without
          // it browsers drop the fill and the tiles come out as white boxes.
          printColorAdjust: "exact",
          WebkitPrintColorAdjust: "exact",
        }}
      >
        {icon}
      </div>
      <p
        style={{
          margin: 0,
          marginTop: mm(0.7),
          fontSize: pt(4.6),
          fontWeight: 700,
          lineHeight: 1.15,
          letterSpacing: "0.02em",
        }}
      >
        {caption}
      </p>
    </div>
  );
}

/** One line in the contact column: icon, then value. */
function ContactLine({
  icon,
  value,
  pt,
  mm,
}: {
  icon: React.ReactNode;
  value: string;
  pt: (n: number) => string;
  mm: (n: number) => string;
}) {
  if (!value) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: mm(1.4),
        fontSize: pt(5.4),
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: INK, display: "flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

export function PackageSlip({
  order,
  store,
  scale,
  showBarcodeZone = true,
  showItems = false,
  highlight = null,
  contentWidthMm,
}: PackageSlipProps) {
  /** Font size in points, scaled to the stock. */
  const pt = (base: number) => `${(base * scale).toFixed(2)}pt`;
  /** Structural spacing in millimetres, scaled to the stock. */
  const mm = (base: number) => `${(base * scale).toFixed(2)}mm`;

  const ship = readAddress(order.shippingAddress);
  const shipName =
    ship.name ||
    [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ") ||
    "—";
  const shipPhone = ship.phone ?? order.customer?.phone ?? "";

  const dateStr = new Date(
    order.externalCreatedAt ?? order.createdAt,
  ).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

  const iconPx = Math.round(9 * scale);
  const careIconPx = Math.round(11 * scale);

  const hairline = `${Math.max(0.18, 0.22 * scale).toFixed(2)}mm solid ${INK}`;

  // Code 128 of the order id: scanning it on the packing queue opens the
  // order. Two dots at 203 dpi (0.25 mm) so a thermal roll prints it crisply.
  const orderBarcode = planBarcode({
    value: order.id,
    availableMm: contentWidthMm ?? (SLIP_REF_W_MM - 6) * scale,
    dpi: 203,
    preferDots: 2,
    maxBarHeightMm: 7 * scale,
  });

  return (
    <div
      className="slip-root"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxSizing: "border-box",
        fontFamily: '"Helvetica Neue", Arial, sans-serif',
        color: "#111",
        background: "#fff",
      }}
    >
      {/* Header band */}
      <div
        style={{
          background: INK,
          color: "#fff",
          textAlign: "center",
          padding: `${mm(1.8)} 0`,
          fontSize: pt(11),
          fontWeight: 700,
          letterSpacing: "0.18em",
          printColorAdjust: "exact",
          WebkitPrintColorAdjust: "exact",
        }}
      >
        PACKAGE SLIP
      </div>

      {/* Brand row: logo + wordmark on the left, date / order no on the right */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: mm(3),
          padding: `${mm(2.6)} 0`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: mm(2), minWidth: 0 }}>
          {store.logoUrl && (
            <img
              src={store.logoUrl}
              alt=""
              style={{ height: mm(7), width: "auto", maxWidth: mm(18), objectFit: "contain" }}
            />
          )}
          <p
            style={{
              margin: 0,
              fontSize: pt(10),
              fontWeight: 700,
              letterSpacing: "0.12em",
              overflowWrap: "anywhere",
            }}
          >
            {store.name.toUpperCase()}
          </p>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, fontSize: pt(5.8), lineHeight: 1.45 }}>
          <p style={{ margin: 0, fontWeight: 700 }}>Date:</p>
          <p style={{ margin: 0 }}>{dateStr}</p>
          <p style={{ margin: 0, marginTop: mm(0.8), fontWeight: 700 }}>Order No:</p>
          <p style={{ margin: 0 }}>{order.name}</p>
        </div>
      </div>

      {orderBarcode.quality !== "unfit" && (
        <div style={{ paddingBottom: mm(2.2) }}>
          <BarcodeSvg plan={orderBarcode} maxHeightMm={orderBarcode.barHeightMm} />
        </div>
      )}

      {/* From | To. flex:1 + minHeight:0 gives the address blocks a definite
          height, which is what AutoFitText measures against. */}
      <div
        style={{
          display: "flex",
          border: hairline,
          flex: "1 1 0",
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            padding: mm(2.2),
            borderRight: hairline,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <p style={{ margin: 0, marginBottom: mm(1), fontSize: pt(5), color: "#555" }}>From</p>
          <div style={{ flex: "1 1 0", minHeight: 0 }}>
            <AutoFitText
              basePt={6 * scale}
              fitKey={`from-${scale}-${store.name}-${store.addressLines.join("|")}`}
            >
              <p style={{ margin: 0, fontWeight: 700, lineHeight: 1.45 }}>
                {store.name.toUpperCase()}
              </p>
              <div style={{ marginTop: "0.6em", lineHeight: 1.5 }}>
                {store.addressLines.map((line, i) => (
                  <p key={i} style={{ margin: 0, overflowWrap: "anywhere" }}>
                    {line}
                  </p>
                ))}
              </div>
              {store.website && (
                <p style={{ margin: 0, marginTop: "0.6em", overflowWrap: "anywhere" }}>
                  Online: {store.website}
                </p>
              )}
            </AutoFitText>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            padding: mm(2.2),
            display: "flex",
            flexDirection: "column",
          }}
        >
          <p style={{ margin: 0, marginBottom: mm(1), fontSize: pt(5), color: "#555" }}>To</p>
          <div style={{ flex: "1 1 0", minHeight: 0 }}>
            <AutoFitText
              basePt={6 * scale}
              fitKey={`to-${scale}-${shipName}-${ship.lines.join("|")}-${shipPhone}`}
            >
              <p style={{ margin: 0, fontWeight: 700, lineHeight: 1.45 }}>
                {shipName.toUpperCase()}
              </p>
              <div style={{ marginTop: "0.6em", lineHeight: 1.5 }}>
                {ship.hasAddress ? (
                  ship.lines.map((line, i) => (
                    <p key={i} style={{ margin: 0, overflowWrap: "anywhere" }}>
                      {line}
                    </p>
                  ))
                ) : (
                  <p style={{ margin: 0, fontStyle: "italic", color: "#777" }}>
                    No shipping address on this order.
                  </p>
                )}
                {shipPhone && <p style={{ margin: 0, marginTop: "0.4em" }}>{shipPhone}</p>}
              </div>
            </AutoFitText>
          </div>
        </div>
      </div>

      {/* Optional contents list. Off by default — the reference design has no
          item table — but a packer working from the slip alone wants one. */}
      {showItems && order.lineItems.length > 0 && (
        <div
          style={{
            borderLeft: hairline,
            borderRight: hairline,
            borderBottom: hairline,
            padding: mm(2),
            height: mm(18),
            boxSizing: "border-box",
            ...(highlight === "items" ? HIGHLIGHT : null),
          }}
        >
          <AutoFitText
            basePt={5.6 * scale}
            fitKey={`items-${scale}-${order.lineItems.length}-${order.id}`}
          >
            {order.lineItems.map((li) => (
              <p
                key={li.id}
                style={{
                  margin: 0,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1em",
                  lineHeight: 1.5,
                }}
              >
                <span style={{ overflowWrap: "anywhere" }}>
                  {li.title}
                  {li.variantTitle && li.variantTitle !== "Default Title"
                    ? ` (${li.variantTitle})`
                    : ""}
                  {li.sku ? ` · ${li.sku}` : ""}
                </span>
                <span style={{ fontWeight: 700, flexShrink: 0 }}>× {li.quantity}</span>
              </p>
            ))}
          </AutoFitText>
        </div>
      )}

      {/* Reserved barcode strip — intentionally blank, see showBarcodeZone. */}
      {showBarcodeZone && (
        <div
          style={{
            padding: `${mm(2.4)} 0 ${mm(1.2)}`,
            ...(highlight === "barcode" ? HIGHLIGHT : null),
          }}
        >
          <p style={{ margin: 0, fontSize: pt(6), fontWeight: 700, letterSpacing: "0.04em" }}>
            Barcode :
          </p>
          <div
            style={{
              height: mm(16),
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: pt(5),
              color: "#3d6000",
              border: highlight === "barcode" ? "1px dashed #3d6000" : undefined,
            }}
          >
            {highlight === "barcode" ? "Courier label goes here" : null}
          </div>
        </div>
      )}

      <div style={{ borderTop: hairline }} />

      {/* Footer: contacts on the left, care symbols on the right */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: mm(4),
          paddingTop: mm(2.4),
        }}
      >
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: mm(0.9) }}>
          <ContactLine
            icon={<Phone size={iconPx} strokeWidth={2} />}
            value={store.phone}
            pt={pt}
            mm={mm}
          />
          <ContactLine
            icon={<MessageCircle size={iconPx} strokeWidth={2} />}
            value={store.whatsapp}
            pt={pt}
            mm={mm}
          />
          <ContactLine
            icon={<Mail size={iconPx} strokeWidth={2} />}
            value={store.email}
            pt={pt}
            mm={mm}
          />
        </div>

        <div style={{ flexShrink: 0, width: mm(46) }}>
          <p
            style={{
              margin: 0,
              marginBottom: mm(1.2),
              textAlign: "center",
              fontSize: pt(6),
              fontWeight: 700,
            }}
          >
            Handle With Care
          </p>
          <div style={{ display: "flex", gap: mm(1.6) }}>
            <CareTile
              icon={<Umbrella size={careIconPx} strokeWidth={2} />}
              caption="KEEP DRY"
              pt={pt}
              mm={mm}
            />
            <CareTile
              icon={<Recycle size={careIconPx} strokeWidth={2} />}
              caption="RECYCLE"
              pt={pt}
              mm={mm}
            />
            <CareTile
              icon={<Flame size={careIconPx} strokeWidth={2} />}
              caption="KEEP AWAY FROM HEAT"
              pt={pt}
              mm={mm}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
