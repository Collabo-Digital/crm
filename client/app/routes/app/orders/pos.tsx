import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { isAxiosError } from "axios";
import { ChevronUp, Eye, Lock, QrCode, Settings, Store, WifiOff } from "lucide-react";
import { QueryErrorState } from "~/components/app/query-error-state";
import { CameraScanner, type ScanFeedback } from "~/components/app/pos/camera-scanner";
import { CartPanel } from "~/components/app/pos/cart-panel";
import { CustomItemDialog } from "~/components/app/pos/custom-item-dialog";
import { CustomerStep } from "~/components/app/pos/customer-step";
import { PaymentDialog } from "~/components/app/pos/payment-dialog";
import { PinPad } from "~/components/app/pos/pin-pad";
import { PosScreen } from "~/components/app/pos/pos-screen";
import { ProductFinder, stockLabel, type ScanNotice } from "~/components/app/pos/product-finder";
import { SaleComplete } from "~/components/app/pos/sale-complete";
import { PosSnackbar, type Snack } from "~/components/app/pos/snackbar";
import { TillPhoneHeader } from "~/components/app/pos/till-phone-header";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { useKeyboardWedge } from "~/hooks/use-barcode-wedge";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useCollectPosPaymentMutation, useCreatePosSaleMutation, usePosApproveMutation, usePosUnlockMutation } from "~/hooks/use-pos-mutations";
import { usePosSetup } from "~/hooks/use-pos-queries";
import { useSectionAccess } from "~/hooks/use-section-access";
import { serverMessage } from "~/lib/handle-mutation-error";
import {
  approvalNeeded,
  billRef,
  cartTotals,
  hasNameAndAddress,
  needsNameAndAddress,
  newClientSaleId,
  oversold,
  saleCustomer,
  saleLines,
  type PosCartCustomer,
  type PosCartLine,
} from "~/lib/pos-cart";
import { beep, readSavedStore, readStaffSession, saveStaffSession, saveStore, type PosStaffSession } from "~/lib/pos-device";
import { cn, formatCurrency } from "~/lib/utils";
import { posService } from "~/services/pos.service";
import { useAuthStore } from "~/stores/auth.store";
import type { PosDiscount, PosPaymentInput, PosProduct, PosSaleResult } from "~/types/api";

export function meta() {
  return [{ title: "Point of sale | Collabo CRM" }];
}

const inr = (n: number) => formatCurrency(n, "INR");
const productName = (p: Pick<PosProduct, "title" | "variantTitle">) => `${p.title}${p.variantTitle ? ` (${p.variantTitle})` : ""}`;

type DialogName = "customer" | "custom" | "camera" | "approval" | "pay" | "collect" | "staff";

interface Approval {
  token: string;
  expiresAt: string;
  approverName: string;
  /** The cart's discounts and prices when the manager approved them. */
  signature: string;
}

/**
 * Point of sale — the counter billing screen, after Shopify POS's cashier
 * flow: find items (search, scanner, camera, quick items, custom item),
 * build the cart, say who is buying, take payment in one or several methods,
 * then send, share or print the bill. The cart lives in this page only; the
 * server bills it once per clientSaleId however many times it is sent.
 *
 * On a phone the till is its own app: no app bar or tabs, a slim header, a
 * bottom bar with the total and Charge, and full-screen steps.
 */
export default function PosPage() {
  const orgId = useAuthStore((s) => s.currentOrgId);
  const user = useAuthStore((s) => s.user);
  const { role } = useCurrentRole();
  const { canAccess, landingPath } = useSectionAccess();
  const canManage = role === "OWNER" || role === "ADMIN" || role === "MANAGER";
  const canSell = role !== "VIEWER";

  const [storeId, setStoreId] = useState(() => readSavedStore(orgId));
  const setup = usePosSetup(storeId);
  const data = setup.data;
  const settings = data?.settings;
  // Composition sellers charge no GST, so the till neither estimates it nor asks for a rate.
  const chargesGst = !!data?.gstEnabled && !data.composition;
  const stores = data?.stores ?? [];
  const activeStore = stores.find((s) => s.id === storeId) ?? stores.find((s) => s.isDefault) ?? stores[0];

  // A remembered store that was since closed, or belongs to another org.
  useEffect(() => {
    if (!storeId) return;
    const refused = isAxiosError(setup.error) && [400, 403, 404].includes(setup.error.response?.status ?? 0);
    if (refused || (data && !data.stores.some((s) => s.id === storeId))) {
      saveStore(orgId, null);
      setStoreId(undefined);
    }
  }, [storeId, setup.error, data, orgId]);

  const chooseStore = (id: string) => {
    saveStore(orgId, id);
    setStoreId(id);
  };

  // ── Staff ──
  const [staff, setStaff] = useState<PosStaffSession | null>(() => readStaffSession(orgId));
  const lock = useCallback(() => {
    saveStaffSession(orgId, null);
    setStaff(null);
  }, [orgId]);
  useEffect(() => {
    if (!staff) return;
    const t = setTimeout(lock, Math.min(Math.max(0, new Date(staff.expiresAt).getTime() - Date.now()), 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [staff, lock]);
  const locked = canSell && !!settings?.requireStaffPin && !staff;

  // ── Cart ──
  const [lines, setLines] = useState<PosCartLine[]>([]);
  const [cartDiscount, setCartDiscount] = useState<PosDiscount | null>(null);
  const [note, setNote] = useState("");
  const [customer, setCustomer] = useState<PosCartCustomer | null>(null);
  const [clientSaleId, setClientSaleId] = useState(newClientSaleId);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [flash, setFlash] = useState<{ key: string; at: number } | null>(null);
  const [notice, setNotice] = useState<ScanNotice | null>(null);
  const [lastScan, setLastScan] = useState<ScanFeedback | null>(null);
  const [scanning, setScanning] = useState(0);
  const [result, setResult] = useState<PosSaleResult | null>(null);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [customerPurpose, setCustomerPurpose] = useState<"checkout" | "cart">("cart");
  const [cartOpen, setCartOpen] = useState(false);
  const [pinError, setPinError] = useState<{ text: string | null; key: number }>({ text: null, key: 0 });
  const [snack, setSnack] = useState<Snack | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);

  const totals = useMemo(() => cartTotals(lines, cartDiscount, !!settings?.roundOff), [lines, cartDiscount, settings?.roundOff]);
  const approvalNeed = useMemo(() => (settings ? approvalNeeded(lines, cartDiscount, settings) : null), [lines, cartDiscount, settings]);
  const approvalValid =
    !!approval && !!approvalNeed && approval.signature === approvalNeed.signature && new Date(approval.expiresAt).getTime() > Date.now();
  const inCart = useMemo(() => new Map(lines.filter((l) => l.product).map((l) => [l.key, l.quantity])), [lines]);

  const unlock = usePosUnlockMutation();
  const approve = usePosApproveMutation();
  const createSale = useCreatePosSaleMutation();
  const collect = useCollectPosPaymentMutation();

  const phone = useMediaQuery("(max-width: 767px)");
  const snackId = useRef(0);
  const say = useCallback((next: Omit<Snack, "id">) => setSnack({ ...next, id: ++snackId.current }), []);
  const dismissSnack = useCallback(() => setSnack(null), []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // ── Focus: the search box holds focus whenever nothing else does, so a
  // scanner always types somewhere. Only with a mouse: on a touch screen it
  // would keep raising the on-screen keyboard. ──
  const searchRef = useRef<HTMLInputElement>(null);
  const finePointer = useMediaQuery("(pointer: fine)");
  const anyDialog = dialog !== null || cartOpen;
  const blockedRef = useRef(false);
  blockedRef.current = anyDialog || locked || !!result;
  const focusSearch = useCallback(() => {
    if (finePointer) searchRef.current?.focus({ preventScroll: true });
  }, [finePointer]);
  useEffect(() => {
    if (!finePointer) return;
    const onFocusOut = () =>
      setTimeout(() => {
        if (!blockedRef.current && (document.activeElement === document.body || !document.activeElement)) searchRef.current?.focus({ preventScroll: true });
      }, 0);
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, [finePointer]);
  useEffect(() => {
    if (data && !locked && !result && !anyDialog) focusSearch();
  }, [data, locked, result, anyDialog, focusSearch]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const linesRef = useRef(lines);
  linesRef.current = lines;
  const resultRef = useRef(result);
  resultRef.current = result;

  const newSale = useCallback(() => {
    setLines([]);
    setCartDiscount(null);
    setNote("");
    setCustomer(null);
    setApproval(null);
    setClientSaleId(newClientSaleId());
    setResult(null);
    setSaleError(null);
    setCartOpen(false);
    setLastScan(null);
    setTimeout(focusSearch, 0);
  }, [focusSearch]);

  /** Adds one, says so where the cart is out of sight, and warns inline (not over the till) when stock runs short. */
  const addProduct = useCallback(
    (p: PosProduct, scanned = false) => {
      // Scanning on the success screen starts the next sale.
      if (resultRef.current) newSale();
      const current = resultRef.current ? [] : linesRef.current;
      const existing = current.find((l) => l.key === p.variantId);
      const next: PosCartLine = existing
        ? { ...existing, quantity: existing.quantity + 1 }
        : {
            key: p.variantId,
            product: p,
            title: p.title,
            variantTitle: p.variantTitle,
            quantity: 1,
            listPrice: p.price,
            unitPrice: p.price,
            discount: null,
            gstRate: p.gstRate ?? null,
          };
      setLines((prev) => (prev.some((l) => l.key === p.variantId) ? prev.map((l) => (l.key === p.variantId ? { ...l, quantity: l.quantity + 1 } : l)) : [...prev, next]));
      setFlash({ key: p.variantId, at: Date.now() });
      const undo = {
        label: "Undo",
        onClick: () => setLines((prev) => prev.flatMap((l) => (l.key !== p.variantId ? [l] : l.quantity > 1 ? [{ ...l, quantity: l.quantity - 1 }] : []))),
      };
      if (oversold(next) && !(existing && oversold(existing))) {
        say({
          tone: "warning",
          text:
            p.stockAtStore != null && p.stockAtStore > 0
              ? `Only ${p.stockAtStore} of ${productName(p)} in stock at this store.`
              : `${productName(p)} is out of stock at this store.`,
          action: undo,
        });
      } else if (phone || scanned) {
        say({ text: `Added ${productName(p)} · ${inr(p.price)}`, action: undo });
      }
    },
    [newSale, phone, say],
  );

  const addFromFinder = (p: PosProduct) => {
    addProduct(p);
    focusSearch();
  };

  const scan = useCallback(
    async (code: string) => {
      setScanning((n) => n + 1);
      try {
        const p = await posService.scan(code, activeStore?.id);
        beep(true);
        if (canSell) {
          addProduct(p, true);
          setLastScan({ ok: true, text: `Added ${productName(p)}`, at: Date.now() });
        } else {
          const stock = stockLabel(p);
          const text = [p.title, p.variantTitle, inr(p.price), stock?.text].filter(Boolean).join(" · ");
          setNotice({ ok: true, text, at: Date.now() });
          setLastScan({ ok: true, text, at: Date.now() });
        }
      } catch (error) {
        beep(false);
        const text = serverMessage(error, "No product has this barcode or SKU.");
        setNotice({ ok: false, text, at: Date.now() });
        setLastScan({ ok: false, text, at: Date.now() });
      } finally {
        setScanning((n) => n - 1);
      }
    },
    [activeStore?.id, canSell, addProduct],
  );

  useKeyboardWedge(scan, !!data && stores.length > 0 && !locked && !anyDialog);

  const updateLine = (key: string, patch: Partial<PosCartLine>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) => {
    const index = lines.findIndex((l) => l.key === key);
    const line = lines[index];
    if (!line) return;
    setLines((prev) => prev.filter((l) => l.key !== key));
    say({
      text: `Removed ${line.title}.`,
      action: { label: "Undo", onClick: () => setLines((prev) => (prev.some((l) => l.key === key) ? prev : [...prev.slice(0, index), line, ...prev.slice(index)])) },
    });
  };
  const clearCart = () => {
    const saved = { lines, cartDiscount, note, customer };
    setLines([]);
    setCartDiscount(null);
    setNote("");
    setCustomer(null);
    setApproval(null);
    say({
      text: "Cart cleared.",
      action: {
        label: "Undo",
        onClick: () => {
          setLines(saved.lines);
          setCartDiscount(saved.cartDiscount);
          setNote(saved.note);
          setCustomer(saved.customer);
        },
      },
    });
  };
  const removeCustomer = () => {
    const saved = customer;
    setCustomer(null);
    say({ text: "Customer removed.", action: { label: "Undo", onClick: () => setCustomer(saved) } });
  };
  const pickCustomer = () => {
    setCustomerPurpose("cart");
    setDialog("customer");
  };

  // Charge asks who is buying first — unless the store said not to, or
  // someone is already on the cart. From `customerRequiredAbove` the bill
  // needs a name and address whatever the setting.
  const customerStepNeeded =
    !!settings &&
    (needsNameAndAddress(totals.payable, settings) ? !hasNameAndAddress(customer) : settings.customerAtCheckout !== "off" && !customer);

  const startPay = useCallback(
    (skipCustomer = false) => {
      if (!settings || !canSell || lines.length === 0) return;
      setCartOpen(false);
      setSnack(null);
      if (!skipCustomer && customerStepNeeded) {
        setCustomerPurpose("checkout");
        setDialog("customer");
        return;
      }
      setSaleError(null);
      if (approvalNeed && !approvalValid) {
        setPinError({ text: null, key: 0 });
        setDialog("approval");
        return;
      }
      setDialog("pay");
    },
    [settings, canSell, lines.length, customerStepNeeded, approvalNeed, approvalValid],
  );

  // Keyboard shortcuts for a till with a keyboard.
  useEffect(() => {
    if (locked || anyDialog) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (e.key === "F2" || (e.key === "/" && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (!result && (e.key === "F9" || (e.key === "Enter" && (e.ctrlKey || e.metaKey)))) {
        e.preventDefault();
        startPay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locked, anyDialog, result, startPay]);

  const submitPin = (pin: string) => {
    const onError = (error: unknown) => setPinError((p) => ({ text: serverMessage(error, "That PIN was not accepted."), key: p.key + 1 }));
    if (dialog === "approval" && approvalNeed) {
      approve.mutate(
        { pin, reason: approvalNeed.reason, amount: approvalNeed.amount },
        {
          onSuccess: (r) => {
            setApproval({ token: r.approvalToken, expiresAt: r.expiresAt, approverName: r.approver.name, signature: approvalNeed.signature });
            setDialog("pay");
          },
          onError,
        },
      );
      return;
    }
    unlock.mutate(pin, {
      onSuccess: (r) => {
        const session = { staff: r.staff, staffToken: r.staffToken, expiresAt: r.expiresAt };
        saveStaffSession(orgId, session);
        setStaff(session);
        setDialog(null);
        setPinError({ text: null, key: 0 });
        say({ text: `${r.staff.name} is billing.` });
      },
      onError,
    });
  };

  /**
   * The server answers 403 when the staff token is missing, expired or
   * belongs to someone deactivated. The till goes back to the PIN pad with the
   * server's sentence; the cart stays. Any approval is dropped too, so a
   * manager is asked again rather than the same refusal coming back.
   */
  const staffRefused = (error: unknown) => {
    if (!isAxiosError(error) || error.response?.status !== 403 || !(settings?.requireStaffPin || staff)) return false;
    const text = serverMessage(error, "Unlock the till with a staff PIN first.");
    lock();
    setApproval(null);
    setPinError((p) => ({ text, key: p.key }));
    setDialog(settings?.requireStaffPin ? null : "staff");
    return true;
  };

  const submitSale = (payments: PosPaymentInput[]) => {
    setSaleError(null);
    createSale.mutate(
      {
        clientSaleId,
        storeId: activeStore?.id,
        customer: saleCustomer(customer),
        lines: saleLines(lines),
        cartDiscount: cartDiscount ?? undefined,
        payments,
        note: note.trim() || undefined,
        staffToken: staff?.staffToken,
        approvalToken: approvalValid ? approval?.token : undefined,
      },
      {
        onSuccess: (r) => {
          setResult(r);
          setDialog(null);
        },
        onError: (error) => {
          if (!staffRefused(error)) setSaleError(serverMessage(error, "The sale was not saved. Check the connection and try again."));
        },
      },
    );
  };

  const submitCollect = ([payment]: PosPaymentInput[]) => {
    if (!result) return;
    setSaleError(null);
    collect.mutate(
      { orderId: result.orderId, ...payment, staffToken: staff?.staffToken },
      {
        onSuccess: (r) => {
          setResult(r);
          setDialog(null);
          say({ text: r.balanceDue > 0 ? `${inr(r.paid)} paid so far.` : "The bill is fully paid." });
        },
        onError: (error) => {
          if (!staffRefused(error)) setSaleError(serverMessage(error, "The payment was not saved. Check the connection and try again."));
        },
      },
    );
  };

  // noopener: the receipt's print dialog must not block the till in the same process.
  const printReceipt = (orderId: string) => window.open(`/orders/pos/receipts/${orderId}/print`, "_blank", "noopener");

  const upi = settings?.upiId ? { upiId: settings.upiId, payeeName: settings.upiPayeeName || data?.storeName || "" } : null;
  const staffName = staff?.staff.name ?? user?.firstName ?? "Staff";
  const ref = billRef(clientSaleId);
  const storeTitle = activeStore?.name ?? data?.storeName ?? "Point of sale";

  // Hidden while locked: the lock screen is the PIN pad, and two pads would both take the digits.
  const staffBadge = canSell && !locked && stores.length > 0 && (
    <button
      type="button"
      onClick={() => {
        setPinError({ text: null, key: 0 });
        setDialog("staff");
      }}
      aria-label={`${staffName} is billing. Switch staff`}
      className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 md:min-h-9 md:bg-card md:py-1 md:pl-1 md:pr-3 md:shadow-sm md:ring-1 md:ring-border"
    >
      <span className="flex size-8 items-center justify-center rounded-full bg-brand text-label text-brand-foreground">
        {staffName.charAt(0).toUpperCase()}
      </span>
      <span className="hidden text-left leading-tight md:block">
        <span className="block text-label">{staffName}</span>
        <span className="block text-micro text-muted-foreground">{staff ? (staff.staff.role === "MANAGER" ? "Manager" : "Cashier") : "Tap to switch"}</span>
      </span>
    </button>
  );

  const cartPanel = (onClose?: () => void) => (
    <CartPanel
      // A new sale starts with the discount and note editors closed and empty.
      key={clientSaleId}
      lines={lines}
      totals={totals}
      flashKey={flash}
      customer={customer}
      customerRequired={settings?.customerAtCheckout === "required"}
      cartDiscount={cartDiscount}
      note={note}
      gstEnabled={chargesGst}
      priceChangeNeedsPin={!!settings?.priceOverrideNeedsApproval}
      approvalNeed={approvalNeed}
      approvedBy={approvalValid ? approval!.approverName : null}
      onLine={updateLine}
      onRemove={removeLine}
      onClear={clearCart}
      onCartDiscount={setCartDiscount}
      onNote={setNote}
      onPickCustomer={pickCustomer}
      onRemoveCustomer={removeCustomer}
      onPay={() => startPay()}
      onClose={onClose}
      footerExtra={
        onClose && (
          <div className="relative h-0">
            <PosSnackbar snack={snack} onDismiss={dismissSnack} className="absolute inset-x-0 bottom-2" />
          </div>
        )
      }
    />
  );

  // A card on a larger screen; edge to edge on a phone.
  const panel = "flex min-h-0 flex-col overflow-hidden md:rounded-xl md:bg-card md:shadow-sm md:ring-1 md:ring-border";
  const showBar = canSell && !locked && !result && !!data && stores.length > 0 && lines.length > 0 && !(searchFocused && !finePointer);

  let body;
  if (setup.isLoading) {
    body = (
      <div className="grid min-h-0 flex-1 gap-3 max-md:p-3 md:grid-cols-[minmax(0,1fr)_380px]">
        <Skeleton className="h-full min-h-64 rounded-xl" />
        <Skeleton className="hidden h-full rounded-xl md:block" />
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <QueryErrorState resource="the till" onRetry={() => void setup.refetch()} />
      </div>
    );
  } else if (stores.length === 0) {
    // The till sells from Store locations only, and the server refuses a sale
    // without one.
    body = (
      <section className={cn(panel, "flex-1 items-center justify-center overflow-y-auto px-4 py-8")}>
        <div className="max-w-sm space-y-3 text-center">
          <Store className="mx-auto size-8 text-muted-foreground" />
          <h2 className="font-heading text-subhead">Add a store location to start billing.</h2>
          <p className="text-caption text-muted-foreground">
            {canManage
              ? "The point of sale sells from store locations. Warehouses keep stock but don't bill."
              : "The point of sale sells from store locations. Ask a manager to add one."}
          </p>
          {canManage && (
            <Button asChild variant="accent">
              <Link to="/products/inventory/warehouses?new=store">Add a store location</Link>
            </Button>
          )}
        </div>
      </section>
    );
  } else if (locked) {
    body = (
      <section className={cn(panel, "flex-1 items-center justify-center overflow-y-auto px-4 py-8")}>
        {data.staff.length === 0 ? (
          <div className="max-w-sm space-y-3 text-center">
            <Lock className="mx-auto size-8 text-muted-foreground" />
            <h2 className="font-heading text-subhead">No staff can unlock this till yet</h2>
            <p className="text-caption text-muted-foreground">
              Staff PINs are switched on, but no one has a PIN.{" "}
              {canManage ? "Add your team in POS settings." : "Ask a manager to add you in POS settings."}
            </p>
            {canManage && (
              <Button asChild variant="accent">
                <Link to="/orders/pos/settings">Open POS settings</Link>
              </Button>
            )}
          </div>
        ) : (
          <PinPad
            title="Enter your PIN"
            description={[data.storeName, activeStore?.name].filter(Boolean).join(" · ")}
            submitLabel="Unlock"
            pending={unlock.isPending}
            error={pinError.text}
            errorKey={pinError.key}
            onSubmit={submitPin}
          />
        )}
      </section>
    );
  } else if (result) {
    body = (
      // Full screen on a phone, over the till's own header.
      <section className={cn(panel, "flex-1 max-md:fixed max-md:inset-0 max-md:z-40 max-md:bg-background")}>
        <SaleComplete
          result={result}
          storeName={data.storeName}
          whatsapp={data.billDelivery.whatsapp}
          canManage={canManage}
          staffToken={staff?.staffToken}
          onStaffRefused={staffRefused}
          onPrint={() => printReceipt(result.orderId)}
          onCollect={() => {
            setSaleError(null);
            setDialog("collect");
          }}
          onNewSale={newSale}
        />
      </section>
    );
  } else {
    body = (
      <>
        {!canSell && (
          <p className="flex shrink-0 items-center gap-2 bg-info-subtle px-3 py-2 text-caption text-info md:rounded-lg">
            <Eye className="size-4 shrink-0" />
            You have view-only access: you can look up prices and stock, but not bill.
          </p>
        )}
        <div className={cn("grid min-h-0 flex-1 md:gap-3", canSell && "md:grid-cols-[minmax(0,1fr)_minmax(320px,360px)] lg:grid-cols-[minmax(0,1fr)_400px]")}>
          <section className={panel}>
            <ProductFinder
              storeId={activeStore?.id}
              tiles={data.tiles}
              canSell={canSell}
              searchRef={searchRef}
              notice={notice?.ok === false || !canSell ? notice : null}
              scanning={scanning > 0}
              inCart={inCart}
              onAdd={addFromFinder}
              onScan={(code) => void scan(code)}
              onCamera={() => {
                setLastScan(null);
                setDialog("camera");
              }}
              onCustom={() => setDialog("custom")}
              onSearchFocus={setSearchFocused}
              emptyHint={
                canManage ? (
                  <>
                    Pin your best sellers here as quick items in{" "}
                    <Link to="/orders/pos/settings" className="font-medium text-foreground underline underline-offset-2">
                      POS settings
                    </Link>
                    .
                  </>
                ) : (
                  "A manager can pin best sellers here as quick items."
                )
              }
            />
          </section>
          {canSell && <aside className={cn(panel, "hidden md:flex")}>{cartPanel()}</aside>}
        </div>
        {showBar && (
          <div className="flex shrink-0 gap-2 border-t bg-background px-3 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] md:hidden">
            <button
              type="button"
              onClick={() => {
                setSnack(null);
                setCartOpen(true);
              }}
              aria-label={`Open the cart: ${totals.items} item${totals.items === 1 ? "" : "s"}, ${inr(totals.payable)}`}
              className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border px-3 text-left active:bg-muted"
            >
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-caption text-muted-foreground">
                  {totals.items} item{totals.items === 1 ? "" : "s"}
                </span>
                <span className="block truncate text-label tabular-nums">{inr(totals.payable)}</span>
              </span>
              <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
            </button>
            <Button type="button" variant="accent" className="h-12 flex-[1.4] rounded-xl text-section" onClick={() => startPay()}>
              Charge {inr(totals.payable)}
            </Button>
          </div>
        )}
      </>
    );
  }

  const banners = data && stores.length > 0 && (
    <>
      {!online && (
        <p role="status" className="flex shrink-0 items-center gap-2 bg-warning-subtle px-3 py-2 text-caption text-warning-strong md:rounded-lg">
          <WifiOff className="size-4 shrink-0" />
          You're offline. Sales can't be saved until the connection is back.
        </p>
      )}
      {canManage && canSell && !settings?.upiId && !result && (
        <p className="flex shrink-0 items-center gap-2 bg-muted px-3 py-2 text-caption text-muted-foreground md:rounded-lg">
          <QrCode className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">No UPI ID yet, so UPI payments show no QR code.</span>
          <Link to="/orders/pos/settings" className="shrink-0 font-medium text-foreground underline underline-offset-2">
            Add one
          </Link>
        </p>
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col max-md:bg-background md:gap-3">
      <TillPhoneHeader
        title={storeTitle}
        stores={stores}
        storeId={activeStore?.id}
        onStore={chooseStore}
        staffBadge={staffBadge}
        canManage={canManage}
        onLock={settings?.requireStaffPin && staff ? lock : null}
        exitTo={canAccess("/orders") ? "/orders" : landingPath}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 max-md:hidden">
        <h1 className="font-heading text-page-title">Point of sale</h1>
        {data && <span className="text-body text-muted-foreground">{data.storeName}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {stores.length > 1 && (
            <Select value={activeStore?.id} onValueChange={chooseStore}>
              <SelectTrigger className="h-9 min-w-44 bg-card" aria-label="Store">
                <Store className="size-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stores.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {data && staffBadge}
          {settings?.requireStaffPin && staff && (
            <Button variant="outline" className="h-9" onClick={lock}>
              <Lock />
              Lock
            </Button>
          )}
          {canManage && (
            <Button asChild variant="ghost" className="h-9">
              <Link to="/orders/pos/settings">
                <Settings />
                Settings
              </Link>
            </Button>
          )}
        </div>
      </div>

      {banners}
      {body}

      {!cartOpen && (
        <PosSnackbar
          snack={snack}
          onDismiss={dismissSnack}
          className={cn(
            "fixed inset-x-0 z-40 md:bottom-6",
            result ? "bottom-[calc(96px+env(safe-area-inset-bottom))] md:bottom-28" : showBar ? "bottom-[calc(72px+env(safe-area-inset-bottom))]" : "bottom-[calc(12px+env(safe-area-inset-bottom))]",
          )}
        />
      )}

      {/* Phones: the cart is a full-height screen over the products. */}
      <PosScreen open={cartOpen && phone} onOpenChange={setCartOpen} title="Cart" description="The items in this sale, the customer and the total.">
        {cartPanel(() => setCartOpen(false))}
      </PosScreen>

      {data && settings && (
        <>
          <CustomerStep
            open={dialog === "customer"}
            onOpenChange={(open) => setDialog(open ? "customer" : null)}
            purpose={customerPurpose}
            initial={customer}
            mode={settings.customerAtCheckout}
            payable={totals.payable}
            requiredAbove={settings.customerRequiredAbove}
            autoSendBill={settings.autoSendBill}
            onDone={(next) => {
              setCustomer(next);
              if (customerPurpose === "checkout") startPay(true);
              else setDialog(null);
            }}
            onSkip={() => startPay(true)}
          />
          <CustomItemDialog
            open={dialog === "custom"}
            onOpenChange={(open) => setDialog(open ? "custom" : null)}
            gstEnabled={chargesGst}
            onAdd={(item) => {
              const key = `custom:${newClientSaleId()}`;
              setLines((prev) => [
                ...prev,
                { key, product: null, title: item.title, variantTitle: null, quantity: 1, listPrice: item.price, unitPrice: item.price, discount: null, gstRate: item.gstRate },
              ]);
              setFlash({ key, at: Date.now() });
              if (phone) say({ text: `Added ${item.title} · ${inr(item.price)}`, action: { label: "Undo", onClick: () => setLines((prev) => prev.filter((l) => l.key !== key)) } });
            }}
          />
          <CameraScanner
            open={dialog === "camera"}
            onOpenChange={(open) => setDialog(open ? "camera" : null)}
            variant={phone ? "panel" : "dialog"}
            feedback={lastScan}
            onCode={(code) => {
              if (!phone) setDialog(null);
              void scan(code);
            }}
          />
          <Dialog open={dialog === "staff" || dialog === "approval"} onOpenChange={(open) => !open && setDialog(null)}>
            <DialogContent className="sm:max-w-sm">
              <DialogTitle className="sr-only">{dialog === "approval" ? "Manager approval" : "Switch staff"}</DialogTitle>
              <DialogDescription className="sr-only">{dialog === "approval" ? approvalNeed?.summary : "Enter your PIN to bill as yourself."}</DialogDescription>
              {dialog === "approval" ? (
                <PinPad
                  title="Manager approval"
                  description={`${approvalNeed?.summary ?? ""} A manager enters their PIN to allow it.`}
                  submitLabel="Approve"
                  pending={approve.isPending}
                  error={pinError.text}
                  errorKey={pinError.key}
                  onSubmit={submitPin}
                  className="py-2"
                />
              ) : (
                <PinPad
                  title="Switch staff"
                  description="Enter your PIN to bill as yourself."
                  submitLabel="Switch"
                  pending={unlock.isPending}
                  error={pinError.text}
                  errorKey={pinError.key}
                  onSubmit={submitPin}
                  className="py-2"
                />
              )}
            </DialogContent>
          </Dialog>
          <PaymentDialog
            open={dialog === "pay"}
            onOpenChange={(open) => setDialog(open ? "pay" : null)}
            mode="sale"
            due={totals.payable}
            billRef={ref}
            upi={upi}
            canManage={canManage}
            hasCustomer={!!customer}
            submitting={createSale.isPending}
            error={saleError}
            onSubmit={submitSale}
          />
          {result && (
            <PaymentDialog
              open={dialog === "collect"}
              onOpenChange={(open) => setDialog(open ? "collect" : null)}
              mode="collect"
              due={result.balanceDue}
              billRef={result.orderName}
              upi={upi}
              canManage={canManage}
              hasCustomer={!!result.customerId}
              submitting={collect.isPending}
              error={saleError}
              onSubmit={submitCollect}
            />
          )}
        </>
      )}
    </div>
  );
}
