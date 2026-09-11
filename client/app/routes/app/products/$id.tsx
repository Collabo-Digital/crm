import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useBlocker, useParams } from "react-router";
import {
  Loader2,
  Check,
  AlertTriangle,
  Package,
  Plus,
  Calendar,
  UploadCloud,
} from "lucide-react";
import {
  useProduct,
  useProductTypes,
  useProductVendors,
} from "~/hooks/use-product-queries";
import { useOrders } from "~/hooks/use-order-queries";
import {
  useBulkUpdateVariantsMutation,
  useGenerateVariantsMutation,
  useSyncProductMutation,
  useUpdateOptionsMutation,
  useUpdateProductMutation,
  useUpdateVariantMutation,
} from "~/hooks/use-product-mutations";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useOrganizationSettings } from "~/hooks/use-settings-queries";
import { useInventoryStatus } from "~/hooks/use-inventory-queries";
import { STOCK_TERMS } from "~/lib/inventory-vocabulary";
import { useCurrentOrg } from "~/hooks/use-org-queries";
import { calcMargin, cn, formatCurrency } from "~/lib/utils";
import { formatDate, formatDateTime } from "~/lib/format-date";
import { handleMutationError } from "~/lib/handle-mutation-error";
import {
  newOptionUid,
  normalizeProductOptions,
  type EditableOption,
} from "~/lib/product-options";
import {
  areVariantDraftsDirty,
  buildVariantDrafts,
  isVariantDraftDirty,
  toGstRateOption,
  toInputNumber,
  toNullableNumber,
  type VariantDraft,
} from "~/lib/variant-draft";
import { VariantOptionsCard } from "~/components/app/product-variants/variant-options-card";
import { VariantPriceStockCard } from "~/components/app/product-variants/variant-price-stock-card";
import { COMMON_UQC, GST_RATE_OPTIONS, GST_SUPPLY_TYPES } from "~/lib/gst-uqc";
import { toast } from "sonner";
import type {
  GstSupplyType,
  ProductDetail,
  ProductOption,
  ProductShopifySync,
  ProductStatus,
  ProductVariant,
  UpdateProductRequest,
  UpdateVariantRequest,
} from "~/types/api";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  normalizeBodyHtml,
  RichTextEditor,
} from "~/components/ui/rich-text-editor";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "~/components/ui/combobox";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "~/components/ui/field";
import { Switch } from "~/components/ui/switch";
import { Separator } from "~/components/ui/separator";
import { Item, ItemMedia } from "~/components/ui/item";
import { motion } from "framer-motion";

export function meta() {
  return [{ title: "Product Detail | Collabo CRM" }];
}

const STATUS_CLASS: Record<string, string> = {
  ACTIVE: "bg-[#CEF17B]/30 text-[#084734]",
  DRAFT: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  ARCHIVED: "bg-orange-100 text-orange-700",
};

const STATUS_OPTIONS = ["Active", "Draft", "Archived"] as const;

const STATUS_LABEL: Record<ProductStatus, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  ARCHIVED: "Archived",
};

const STATUS_VALUE: Record<string, ProductStatus> = {
  Active: "ACTIVE",
  Draft: "DRAFT",
  Archived: "ARCHIVED",
};

const PRODUCT_TABS = [
  { id: "overview", label: "Overview" },
  { id: "variants", label: "Variants" },
  { id: "orders", label: "Orders" },
  { id: "channels", label: "Channels" },
  { id: "insights", label: "Insights" },
  { id: "seo", label: "SEO" },
] as const;

type ProductTab = (typeof PRODUCT_TABS)[number]["id"];

function optionsEqual(a: ProductOption[], b: ProductOption[]): boolean {
  return (
    JSON.stringify(normalizeProductOptions(a)) === JSON.stringify(normalizeProductOptions(b))
  );
}

function tagsEqual(a: string[], b: string[]): boolean {
  return (
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  );
}

type FormBaseline = {
  title: string;
  bodyHtml: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: ProductStatus;
  price: string;
  compareAtPrice: string;
  cost: string;
  taxable: boolean;
  sku: string;
  barcode: string;
  trackQuantity: boolean;
  continueSelling: boolean;
  inventoryQuantity: string;
  requiresShipping: boolean;
  weight: string;
  weightUnit: string;
  hsCode: string;
  countryOfOrigin: string;
  hsnCode: string;
  gstRate: string;
  unitOfMeasure: string;
  supplyType: GstSupplyType;
  options: ProductOption[];
  variantDrafts: Record<string, VariantDraft>;
};

function captureBaseline(p: ProductDetail): FormBaseline {
  const defaultVariant = p.variants?.[0];
  return {
    title: p.title,
    bodyHtml: normalizeBodyHtml(p.bodyHtml ?? ""),
    productType: p.productType ?? "",
    vendor: p.vendor ?? "",
    tags: [...(p.tags ?? [])],
    status: p.status,
    price: toInputNumber(defaultVariant?.price),
    compareAtPrice: toInputNumber(defaultVariant?.compareAtPrice),
    cost: toInputNumber(defaultVariant?.cost),
    taxable: defaultVariant?.taxable ?? true,
    sku: defaultVariant?.sku ?? "",
    barcode: defaultVariant?.barcode ?? "",
    trackQuantity: defaultVariant?.trackQuantity ?? true,
    continueSelling: defaultVariant?.continueSellingWhenOutOfStock ?? false,
    inventoryQuantity: toInputNumber(defaultVariant?.inventoryQuantity ?? 0),
    requiresShipping: defaultVariant?.requiresShipping ?? true,
    weight: toInputNumber(defaultVariant?.weight),
    weightUnit: defaultVariant?.weightUnit ?? "kg",
    hsCode: defaultVariant?.hsCode ?? "",
    countryOfOrigin: defaultVariant?.countryOfOrigin ?? "",
    hsnCode: p.hsnCode ?? "",
    gstRate: toGstRateOption(p.gstRate),
    unitOfMeasure: p.unitOfMeasure ?? "",
    supplyType: p.supplyType ?? "TAXABLE",
    options: normalizeProductOptions(p.options ?? []),
    variantDrafts: buildVariantDrafts(p.variants ?? []),
  };
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isVendor } = useCurrentRole();
  const { data: product, isLoading, isError, refetch } = useProduct(id);
  const { data: org } = useCurrentOrg();
  // Org-wide "(all products)" overrides from Settings → Sync. While ON they
  // decide what is pushed to Shopify, so the per-variant switches are shown
  // forced and disabled rather than silently ignored.
  const { data: orgSettings } = useOrganizationSettings();
  const oversellForced = orgSettings?.productSettings?.allowOversellGlobally === true;
  const trackForced = orgSettings?.productSettings?.trackQuantityGlobally === true;
  // With warehousing on, a variant's stock is the sum of its per-warehouse
  // buckets and `inventoryQuantity` is only a cache of it. Writing that field
  // directly bypasses the movement ledger — and the server rejects it outright
  // unless a warehouseId travels with it — so quantity edits go out as
  // adjustments instead. See VariantInlineEditor.
  const warehousingEnabled = useInventoryStatus().data?.warehousingEnabled === true;
  const { data: productTypes = [] } = useProductTypes();
  const { data: vendors = [] } = useProductVendors();
  const currency = org?.currency ?? "INR";
  const [title, setTitle] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [productType, setProductType] = useState("");
  const [vendor, setVendor] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<ProductStatus>("ACTIVE");
  const [price, setPrice] = useState("");
  const [compareAtPrice, setCompareAtPrice] = useState("");
  const [cost, setCost] = useState("");
  const [taxable, setTaxable] = useState(true);
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [trackQuantity, setTrackQuantity] = useState(true);
  const [continueSelling, setContinueSelling] = useState(false);
  const [inventoryQuantity, setInventoryQuantity] = useState("0");
  // Shipping / customs of the default variant (simple products only).
  const [requiresShipping, setRequiresShipping] = useState(true);
  const [weight, setWeight] = useState("");
  const [weightUnit, setWeightUnit] = useState("kg");
  const [hsCode, setHsCode] = useState("");
  const [countryOfOrigin, setCountryOfOrigin] = useState("");
  // Product-level GST fields.
  const [hsnCode, setHsnCode] = useState("");
  const [gstRate, setGstRate] = useState("");
  const [unitOfMeasure, setUnitOfMeasure] = useState("");
  const [supplyType, setSupplyType] = useState<GstSupplyType>("TAXABLE");
  const [activeTab, setActiveTab] = useState<ProductTab>("overview");
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [options, setOptions] = useState<EditableOption[]>([]);
  const [optionValueDrafts, setOptionValueDrafts] = useState<string[]>([]);
  const [variantDrafts, setVariantDrafts] = useState<Record<string, VariantDraft>>(
    {},
  );
  const [hydratedProductId, setHydratedProductId] = useState<string | null>(
    null,
  );
  const [editorReady, setEditorReady] = useState(false);
  const baselineRef = useRef<FormBaseline | null>(null);
  // All save-flow mutations run silent: handleSaveProduct owns the single
  // success/error toast for the whole save.
  const updateMutation = useUpdateProductMutation({ silent: true });
  const updateVariantMutation = useUpdateVariantMutation(id ?? "", { silent: true });
  const bulkUpdateVariantsMutation = useBulkUpdateVariantsMutation(id ?? "", { silent: true });
  const updateOptionsMutation = useUpdateOptionsMutation(id ?? "", { silent: true });
  const generateVariantsMutation = useGenerateVariantsMutation(id ?? "", { silent: true });

  /**
   * Re-seed ONLY the options and the variant table from a freshly saved
   * product.
   *
   * Saving options from the Variants tab has to pick up server-side
   * normalisation and any newly generated rows, but it must not touch the
   * Overview fields: a merchant with an unsaved title or tag edit would
   * otherwise lose it by pressing a button in a different tab.
   */
  const hydrateVariantsFromProduct = useCallback((p: ProductDetail) => {
    const nextOptions = normalizeProductOptions(p.options ?? []);
    const nextDrafts = buildVariantDrafts(p.variants ?? []);
    setOptions(nextOptions.map((option) => ({ ...option, uid: newOptionUid() })));
    setOptionValueDrafts(nextOptions.map(() => ""));
    setVariantDrafts(nextDrafts);
    if (baselineRef.current) {
      baselineRef.current = {
        ...baselineRef.current,
        options: nextOptions,
        variantDrafts: nextDrafts,
      };
    }
  }, []);

  const hydrateFormFromProduct = useCallback((p: ProductDetail) => {
    setTitle(p.title);
    setBodyHtml(p.bodyHtml ?? "");
    setProductType(p.productType ?? "");
    setVendor(p.vendor ?? "");
    setStatus(p.status);
    setTags(p.tags ?? []);
    const nextOptions = normalizeProductOptions(p.options ?? []);
    setOptions(nextOptions.map((option) => ({ ...option, uid: newOptionUid() })));
    setOptionValueDrafts(nextOptions.map(() => ""));
    setVariantDrafts(buildVariantDrafts(p.variants ?? []));
    const defaultVariant = p.variants?.[0];
    setPrice(toInputNumber(defaultVariant?.price));
    setCompareAtPrice(toInputNumber(defaultVariant?.compareAtPrice));
    setCost(toInputNumber(defaultVariant?.cost));
    setTaxable(defaultVariant?.taxable ?? true);
    setSku(defaultVariant?.sku ?? "");
    setBarcode(defaultVariant?.barcode ?? "");
    setTrackQuantity(defaultVariant?.trackQuantity ?? true);
    setContinueSelling(defaultVariant?.continueSellingWhenOutOfStock ?? false);
    setInventoryQuantity(toInputNumber(defaultVariant?.inventoryQuantity ?? 0));
    setRequiresShipping(defaultVariant?.requiresShipping ?? true);
    setWeight(toInputNumber(defaultVariant?.weight));
    setWeightUnit(defaultVariant?.weightUnit ?? "kg");
    setHsCode(defaultVariant?.hsCode ?? "");
    setCountryOfOrigin(defaultVariant?.countryOfOrigin ?? "");
    setHsnCode(p.hsnCode ?? "");
    setGstRate(toGstRateOption(p.gstRate));
    setUnitOfMeasure(p.unitOfMeasure ?? "");
    setSupplyType(p.supplyType ?? "TAXABLE");
    baselineRef.current = captureBaseline(p);
  }, []);

  const handleEditorReady = useCallback((stableValue: string) => {
    setEditorReady(true);
    if (baselineRef.current) {
      baselineRef.current = {
        ...baselineRef.current,
        bodyHtml: normalizeBodyHtml(stableValue),
      };
    }
  }, []);

  useLayoutEffect(() => {
    if (!product) {
      setHydratedProductId(null);
      setEditorReady(false);
      baselineRef.current = null;
      return;
    }
    setEditorReady(false);
    hydrateFormFromProduct(product);
    setHydratedProductId(product.id);
    // Keyed on the id only: refetches of the SAME product (invalidations,
    // sync polling) must not overwrite the user's in-progress edits. Explicit
    // re-sync after a save happens in handleSaveProduct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, hydrateFormFromProduct]);

  useEffect(() => {
    const images =
      product?.images?.length
        ? product.images
        : product?.image
          ? [product.image]
          : [];
    if (!images.length) {
      setSelectedImageId(null);
      return;
    }
    setSelectedImageId((prev) =>
      prev && images.some((img) => img.id === prev) ? prev : images[0].id,
    );
  }, [product?.id, product?.images, product?.image]);

  const typeItems = useMemo(() => {
    const items = [...productTypes];
    if (productType && !items.includes(productType)) items.unshift(productType);
    return items;
  }, [productTypes, productType]);

  const vendorItems = useMemo(() => {
    const items = [...vendors];
    if (vendor && !items.includes(vendor)) items.unshift(vendor);
    return items;
  }, [vendors, vendor]);

  const tagItems = useMemo(() => {
    const set = new Set([...tags, ...(product?.tags ?? [])]);
    return Array.from(set).filter(Boolean).sort();
  }, [tags, product?.tags]);

  // Recent orders that contain this product (filtered server-side via the
  // new productId param we just added).
  const { data: recentOrders } = useOrders(
    id ? { productId: id, limit: 5 } : undefined,
  );

  // useBlocker must run on every render (hooks can't follow the early returns
  // below), but the dirty flags are computed after the product-loaded guard —
  // so the blocker reads them through a ref assigned once they exist.
  const dirtyNavRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyNavRef.current &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  // Only take over the page when there's no cached product to show — a failed
  // background refetch on loaded (possibly dirty) data must not eat the form.
  if (isError && !product) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">
          Couldn't load this product. Check your connection and try again.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (isLoading || !product) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isManual = product.channel?.platform === "MANUAL";
  // Prefer the typed field; fall back to legacy metadata for older records.
  const metadataSync =
    (product.metadata as { shopifySync?: ProductShopifySync } | null | undefined)
      ?.shopifySync ?? null;
  const sync: ProductShopifySync | null = product.shopifySync ?? metadataSync;
  const totalStock = product.totalStock ?? 0;
  const variantsCount = product.variants?.length ?? 0;
  const ordersCount = recentOrders?.meta?.total ?? 0;
  const liveChannelsCount = product.channel ? 1 : 0;
  const primaryImage = product.images?.[0] ?? product.image;
  const galleryImages =
    product.images.length > 0
      ? product.images
      : product.image
        ? [product.image]
        : [];
  const selectedImage =
    galleryImages.find((img) => img.id === selectedImageId) ??
    galleryImages[0] ??
    null;
  const defaultVariant = product.variants?.[0] ?? null;
  const hasVariantOptions =
    (product.options?.length ?? 0) > 0 ||
    (product.variants?.length ?? 0) > 1 ||
    (product.variants ?? []).some(
      (v) =>
        !!v.option2 ||
        !!v.option3 ||
        (!!v.option1 && v.option1 !== "Default Title"),
    );
  const isSimpleProduct = !hasVariantOptions;
  const pricingMargin = calcMargin(price, cost);
  const baseline = baselineRef.current;

  const isPricingDirty =
    isSimpleProduct &&
    !!baseline &&
    (price !== baseline.price ||
      compareAtPrice !== baseline.compareAtPrice ||
      cost !== baseline.cost ||
      taxable !== baseline.taxable);

  const isInventoryDirty =
    isSimpleProduct &&
    !!baseline &&
    (sku !== baseline.sku ||
      barcode !== baseline.barcode ||
      trackQuantity !== baseline.trackQuantity ||
      continueSelling !== baseline.continueSelling ||
      inventoryQuantity !== baseline.inventoryQuantity);

  const isShippingDirty =
    isSimpleProduct &&
    !!baseline &&
    (requiresShipping !== baseline.requiresShipping ||
      weight !== baseline.weight ||
      weightUnit !== baseline.weightUnit ||
      hsCode !== baseline.hsCode ||
      countryOfOrigin !== baseline.countryOfOrigin);

  const isTaxDirty =
    !!baseline &&
    (hsnCode !== baseline.hsnCode ||
      gstRate !== baseline.gstRate ||
      unitOfMeasure !== baseline.unitOfMeasure ||
      supplyType !== baseline.supplyType);

  const isVariantDirty = isPricingDirty || isInventoryDirty || isShippingDirty;
  const isOptionsDirty = baseline
    ? !optionsEqual(options, baseline.options)
    : false;
  const isVariantsTableDirty = baseline
    ? areVariantDraftsDirty(variantDrafts, baseline.variantDrafts)
    : false;

  const isFormReady =
    hydratedProductId === product.id && baselineRef.current != null;
  const isProductDirty =
    isFormReady &&
    editorReady &&
    !!baseline &&
    (title !== baseline.title ||
      normalizeBodyHtml(bodyHtml) !== baseline.bodyHtml ||
      productType !== baseline.productType ||
      vendor !== baseline.vendor ||
      !tagsEqual(tags, baseline.tags) ||
      status !== baseline.status ||
      isTaxDirty ||
      isVariantDirty ||
      isOptionsDirty ||
      isVariantsTableDirty);

  const isSaving =
    updateMutation.isPending ||
    updateVariantMutation.isPending ||
    bulkUpdateVariantsMutation.isPending ||
    updateOptionsMutation.isPending ||
    generateVariantsMutation.isPending;

  // Keep the navigation blocker in sync with the latest dirty state.
  dirtyNavRef.current = isProductDirty && !isSaving;

  function patchVariantDraft(
    variant: ProductVariant,
    patch: Partial<VariantDraft>,
  ) {
    setVariantDrafts((prev) => ({
      ...prev,
      // Variants that appeared after hydration (generated, webhook-created)
      // have no draft yet — seed from the variant itself, never from blanks.
      [variant.id]: {
        ...(prev[variant.id] ?? buildVariantDrafts([variant])[variant.id]),
        ...patch,
      },
    }));
    if (defaultVariant && variant.id === defaultVariant.id) {
      if (patch.price !== undefined) setPrice(patch.price);
      if (patch.cost !== undefined) setCost(patch.cost);
      if (patch.inventoryQuantity !== undefined) {
        setInventoryQuantity(patch.inventoryQuantity);
      }
      if (patch.sku !== undefined) setSku(patch.sku);
    }
  }

  function handleDiscardChanges() {
    if (!product) return;
    hydrateFormFromProduct(product);
  }

  async function handleSaveProduct() {
    if (!product || !isProductDirty) return;

    const data: UpdateProductRequest = {};

    if (title !== product.title) {
      data.title = title;
    }
    if (
      normalizeBodyHtml(bodyHtml) !== normalizeBodyHtml(product.bodyHtml ?? "")
    ) {
      const normalized = normalizeBodyHtml(bodyHtml);
      data.bodyHtml = normalized ? bodyHtml : undefined;
    }
    if (productType !== (product.productType ?? "")) {
      data.productType = productType || undefined;
    }
    if (vendor !== (product.vendor ?? "")) {
      data.vendor = vendor || undefined;
    }
    if (
      JSON.stringify([...tags].sort()) !==
      JSON.stringify([...(product.tags ?? [])].sort())
    ) {
      data.tags = tags;
    }
    if (status !== product.status) {
      data.status = status;
    }
    if (hsnCode !== (product.hsnCode ?? "")) {
      data.hsnCode = hsnCode.trim();
    }
    if (gstRate !== toGstRateOption(product.gstRate) && gstRate !== "") {
      data.gstRate = Number(gstRate);
    }
    if (unitOfMeasure !== (product.unitOfMeasure ?? "")) {
      data.unitOfMeasure = unitOfMeasure;
    }
    if (supplyType !== (product.supplyType ?? "TAXABLE")) {
      data.supplyType = supplyType;
    }

    const hasProductChanges = Object.keys(data).length > 0;

    let variantData: UpdateVariantRequest | null = null;
    if (isVariantDirty && defaultVariant) {
      variantData = {};
      const parsedPrice = Number(price);
      if (
        price.trim() &&
        Number.isFinite(parsedPrice) &&
        price !== toInputNumber(defaultVariant.price)
      ) {
        variantData.price = parsedPrice;
      }
      if (compareAtPrice !== toInputNumber(defaultVariant.compareAtPrice)) {
        const next = toNullableNumber(compareAtPrice);
        if (next !== undefined) variantData.compareAtPrice = next;
      }
      if (cost !== toInputNumber(defaultVariant.cost)) {
        const next = toNullableNumber(cost);
        if (next !== undefined) variantData.cost = next;
      }
      if (taxable !== (defaultVariant.taxable ?? true)) {
        variantData.taxable = taxable;
      }
      if (sku !== (defaultVariant.sku ?? "")) {
        variantData.sku = sku.trim() || null;
      }
      if (barcode !== (defaultVariant.barcode ?? "")) {
        variantData.barcode = barcode.trim() || null;
      }
      if (trackQuantity !== (defaultVariant.trackQuantity ?? true)) {
        variantData.trackQuantity = trackQuantity;
      }
      if (
        continueSelling !==
        (defaultVariant.continueSellingWhenOutOfStock ?? false)
      ) {
        variantData.continueSellingWhenOutOfStock = continueSelling;
      }
      // Warehousing orgs must not send a bare quantity: the server needs a
      // warehouseId with it and 409s the whole save without one. Those edits
      // belong to the variant editor's adjustment path.
      if (
        !warehousingEnabled &&
        inventoryQuantity !==
        toInputNumber(defaultVariant.inventoryQuantity ?? 0)
      ) {
        const parsedQty = Number.parseInt(inventoryQuantity, 10);
        // Blank/garbage input is skipped — never silently zeroed.
        if (Number.isFinite(parsedQty)) {
          variantData.inventoryQuantity = parsedQty;
        }
      }
      if (requiresShipping !== (defaultVariant.requiresShipping ?? true)) {
        variantData.requiresShipping = requiresShipping;
      }
      if (weight !== toInputNumber(defaultVariant.weight)) {
        const next = toNullableNumber(weight);
        if (next !== undefined) variantData.weight = next;
      }
      if (
        weightUnit !== (defaultVariant.weightUnit ?? "kg") &&
        weight.trim() !== ""
      ) {
        variantData.weightUnit = weightUnit as UpdateVariantRequest["weightUnit"];
      }
      if (hsCode !== (defaultVariant.hsCode ?? "")) {
        variantData.hsCode = hsCode.trim() || null;
      }
      if (countryOfOrigin !== (defaultVariant.countryOfOrigin ?? "")) {
        variantData.countryOfOrigin =
          countryOfOrigin.trim().toUpperCase() || null;
      }
      if (Object.keys(variantData).length === 0) {
        variantData = null;
      }
    }

    try {
      if (hasProductChanges) {
        await updateMutation.mutateAsync({ id: product.id, data });
      }
      if (variantData && defaultVariant) {
        await updateVariantMutation.mutateAsync({
          variantId: defaultVariant.id,
          data: variantData,
        });
      }

      const variantUpdates: Array<UpdateVariantRequest & { variantId: string }> =
        [];
      for (const variant of product.variants ?? []) {
        // On simple products, default variant price/cost/stock are saved via Overview.
        if (
          isSimpleProduct &&
          defaultVariant &&
          variant.id === defaultVariant.id
        ) {
          continue;
        }
        const draft = variantDrafts[variant.id];
        if (!isVariantDraftDirty(variant, draft) || !draft) continue;

        const update: UpdateVariantRequest & { variantId: string } = {
          variantId: variant.id,
        };
        if (draft.price !== toInputNumber(variant.price)) {
          const parsedPrice = Number(draft.price);
          if (draft.price.trim() && Number.isFinite(parsedPrice)) {
            update.price = parsedPrice;
          }
        }
        if (draft.cost !== toInputNumber(variant.cost)) {
          const next = toNullableNumber(draft.cost);
          if (next !== undefined) update.cost = next;
        }
        // Same warehousing guard as the default-variant branch above.
        if (
          !warehousingEnabled &&
          draft.inventoryQuantity !==
          toInputNumber(variant.inventoryQuantity ?? 0)
        ) {
          const parsedQty = Number.parseInt(draft.inventoryQuantity, 10);
          if (Number.isFinite(parsedQty)) {
            update.inventoryQuantity = parsedQty;
          }
        }
        if (draft.sku !== (variant.sku ?? "")) {
          update.sku = draft.sku.trim() || null;
        }
        if (Object.keys(update).length > 1) {
          variantUpdates.push(update);
        }
      }
      if (variantUpdates.length > 0) {
        await bulkUpdateVariantsMutation.mutateAsync(variantUpdates);
      }

      if (isOptionsDirty) {
        await persistOptionsAndGenerate();
      }

      // Re-sync the form from the saved product so server-side normalization
      // (and newly generated variants) land in local state deterministically.
      const { data: refreshed } = await refetch();
      if (refreshed) hydrateFormFromProduct(refreshed);

      toast.success("Product saved.");
    } catch (error) {
      handleMutationError(
        error,
        "Save failed — some changes may not have been applied. Please review and save again.",
      );
    }
  }

  /**
   * Persist the option structure, then fill in any combination that has no
   * variant yet. Shared by the page-level Save and the Variants tab's own
   * "Save and generate" so the two can't drift apart.
   */
  async function persistOptionsAndGenerate(): Promise<{ created: number } | null> {
    const normalized = normalizeProductOptions(options);
    const canGenerate =
      normalized.length > 0 &&
      normalized.every((option) => option.name && option.values.length > 0);

    await updateOptionsMutation.mutateAsync(normalized);
    return canGenerate ? await generateVariantsMutation.mutateAsync() : null;
  }

  async function handleSaveAndGenerate() {
    if (!product) return;
    try {
      const result = await persistOptionsAndGenerate();
      const { data: refreshed } = await refetch();
      // Narrow re-hydrate: an unsaved title or tag edit in Overview has to
      // survive pressing a button over here.
      if (refreshed) hydrateVariantsFromProduct(refreshed);
      toast.success(
        result && result.created > 0
          ? `Options saved · ${result.created} new variant${result.created === 1 ? "" : "s"}.`
          : "Options saved.",
      );
    } catch (error) {
      handleMutationError(error, "Couldn't save options.");
    }
  }

  async function handleSaveVariant(variantId: string, data: UpdateVariantRequest) {
    await updateVariantMutation.mutateAsync({ variantId, data });
    // The editor writes fields the Overview cards mirror (compare-at, barcode,
    // the switches). Sync them so the page-level dirty check doesn't resurrect
    // the stale values on the next Save.
    if (defaultVariant && variantId === defaultVariant.id) {
      if (data.compareAtPrice !== undefined) {
        setCompareAtPrice(toInputNumber(data.compareAtPrice));
      }
      if (data.barcode !== undefined) setBarcode(data.barcode ?? "");
      if (data.taxable !== undefined) setTaxable(data.taxable);
      if (data.trackQuantity !== undefined) setTrackQuantity(data.trackQuantity);
      if (data.continueSellingWhenOutOfStock !== undefined) {
        setContinueSelling(data.continueSellingWhenOutOfStock);
      }
    }
  }

  /**
   * Called after the editor's save has fully landed.
   *
   * Moves the baseline as well as the draft: hydration is keyed on the product
   * id, so a per-variant save never refreshes `baselineRef`, and without this
   * the Save/Discard bar would light up and stay lit immediately after a
   * successful "Variant updated". Safe to trust — these values just round
   * tripped through the server.
   */
  function handleVariantPersisted(
    variant: ProductVariant,
    patch: Partial<VariantDraft>,
  ) {
    patchVariantDraft(variant, patch);
    const base = baselineRef.current;
    if (!base) return;
    base.variantDrafts = {
      ...base.variantDrafts,
      [variant.id]: {
        ...(base.variantDrafts[variant.id] ??
          buildVariantDrafts([variant])[variant.id]),
        ...patch,
      },
    };
    toast.success("Variant updated.");
  }

  function handleAddOption() {
    if (options.length >= 3) return;
    setOptions((prev) => [
      ...prev,
      { name: "", values: [], position: prev.length + 1, uid: newOptionUid() },
    ]);
    setOptionValueDrafts((prev) => [...prev, ""]);
  }

  function handleRemoveOption(index: number) {
    setOptions((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((option, i) => ({ ...option, position: i + 1 })),
    );
    setOptionValueDrafts((prev) => prev.filter((_, i) => i !== index));
  }

  function handleOptionNameChange(index: number, name: string) {
    setOptions((prev) =>
      prev.map((option, i) => (i === index ? { ...option, name } : option)),
    );
  }

  function handleRemoveOptionValue(optionIndex: number, valueIndex: number) {
    setOptions((prev) =>
      prev.map((option, i) =>
        i === optionIndex
          ? {
            ...option,
            values: option.values.filter((_, vi) => vi !== valueIndex),
          }
          : option,
      ),
    );
  }

  function handleAddOptionValue(optionIndex: number) {
    const draft = optionValueDrafts[optionIndex]?.trim();
    if (!draft) return;
    setOptions((prev) =>
      prev.map((option, i) => {
        if (i !== optionIndex) return option;
        if (option.values.includes(draft)) return option;
        return { ...option, values: [...option.values, draft] };
      }),
    );
    setOptionValueDrafts((prev) =>
      prev.map((value, i) => (i === optionIndex ? "" : value)),
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/products">Products</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="max-w-xs truncate sm:max-w-md">
                  {product.title}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <div className="flex min-w-0 items-start gap-4">
            {primaryImage && (
              <Item variant="outline" className="w-fit shrink-0 border-0 p-0">
                <ItemMedia variant="image" className="size-16 rounded-lg sm:size-20">
                  <img
                    src={primaryImage.src}
                    alt={primaryImage.alt ?? product.title}
                  />
                </ItemMedia>
              </Item>
            )}

            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[24px] font-bold text-gray-900 dark:text-gray-100">
                  {product.title}
                </h1>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium",
                    STATUS_CLASS[product.status] ?? "bg-gray-100 text-gray-600",
                  )}
                >
                  {product.status}
                </span>
                {isManual ? (
                  <span className="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                    CRM (Manual)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">
                    <Check className="size-3" />
                    Synced from {product.channel?.platform}
                  </span>
                )}
                {product.status === "DRAFT" && product.publishedAt && new Date(product.publishedAt) > new Date() && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
                    <Calendar className="size-3" />
                    Publishes on {formatDateTime(product.publishedAt)}
                  </span>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {product.vendor && <>Vendor: {product.vendor} • </>}
                {product.productType && <>Type: {product.productType} • </>}
                {totalStock} in stock
              </p>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {isProductDirty && (
            <>
              <Button
                type="button"
                variant="outline"
                size="action"
                onClick={handleDiscardChanges}
                disabled={isSaving}
              >
                Discard
              </Button>
              <Button
                type="button"
                variant="brand"
                size="action"
                onClick={handleSaveProduct}
                disabled={isSaving}
              >
                {isSaving && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      <nav
        role="tablist"
        aria-label="Product sections"
        className="flex w-full max-w-full md:w-fit items-center gap-0.5 overflow-x-auto rounded-full bg-foreground/90 dark:bg-gray-900 px-2 py-1.5 shadow-sm ring-1 ring-black/[0.06] dark:ring-gray-700"
      >
        {PRODUCT_TABS.map(({ id, label }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`product-tab-${id}`}
              aria-selected={isActive}
              aria-controls="product-tabpanel"
              onClick={() => setActiveTab(id)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm select-none",
                isActive
                  ? "font-semibold text-gray-900 dark:text-gray-900"
                  : "font-medium text-background hover:text-background/70 dark:text-gray-400 dark:hover:text-gray-200",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="product-tab-pill"
                  initial={false}
                  className="absolute inset-0 rounded-full bg-[#CEF17B]"
                  transition={{
                    type: "spring",
                    stiffness: 380,
                    damping: 32,
                    mass: 1,
                  }}
                />
              )}
              <span className="relative z-10">{label}</span>
            </button>
          );
        })}
      </nav>
      {/* Left side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div
          className="space-y-6 lg:col-span-2"
          role="tabpanel"
          id="product-tabpanel"
          aria-labelledby={`product-tab-${activeTab}`}
        >
          {activeTab === "overview" && (
            <>
              <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-border dark:bg-gray-900">
                <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                  <div>
                    <h2 className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">
                      Product Images
                    </h2>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      Photos and video shown across your channels.
                    </p>
                  </div>
                </div>

                <div className="p-4">
                  {galleryImages.length > 0 ? (
                    <div className="flex items-start gap-3">
                      <div className="relative aspect-square min-w-0 flex-[4] overflow-hidden rounded-2xl bg-[#f5f5f7] dark:bg-gray-800">
                        <span
                          title={selectedImage?.alt ?? undefined}
                          className="absolute left-4 top-4 z-10 max-w-[70%] truncate rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100"
                        >
                          {selectedImage?.alt ?? "Front view"}
                        </span>
                        <div className="flex h-full w-full items-center justify-center">
                          <img
                            src={selectedImage?.src}
                            alt={selectedImage?.alt ?? product.title}
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                      </div>

                      <div className="flex min-w-0 flex-[1] flex-col gap-3">
                        {galleryImages.map((img) => {
                          const isSelected = img.id === selectedImageId;
                          return (
                            <button
                              key={img.id}
                              type="button"
                              onClick={() => setSelectedImageId(img.id)}
                              className={cn(
                                "aspect-square w-full overflow-hidden rounded-xl bg-[#f5f5f7] p-2 dark:bg-gray-800",
                                isSelected
                                  ? "ring-2 ring-[#CEF17B] ring-offset-2 ring-offset-white dark:ring-offset-gray-900"
                                  : "ring-1 ring-transparent",
                              )}
                            >
                              <img
                                src={img.src}
                                alt={img.alt ?? product.title}
                                className="h-full w-full rounded-lg object-cover"
                              />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="flex aspect-square items-center justify-center rounded-2xl bg-[#f5f5f7] text-sm text-muted-foreground dark:bg-gray-800">
                      No product images
                    </div>
                  )}
                </div>
              </div>

              <Section title="Basic Information">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="title"
                      className="text-[12px] font-medium text-muted-foreground"
                    >
                      Title
                    </Label>
                    <Input
                      id="title"
                      placeholder="Title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-[12px] font-medium text-muted-foreground">
                      Description
                    </Label>
                    <RichTextEditor
                      key={product.id}
                      value={bodyHtml}
                      onChange={setBodyHtml}
                      onEditorReady={handleEditorReady}
                      placeholder="Describe this product…"
                    />
                  </div>

                </div>
              </Section>

              {isSimpleProduct && (
                <Section title="Pricing">
                  <div className="space-y-4">
                    <div className="space-y-3">
                      <div className="flex flex-row items-center gap-2">
                        <div className="flex flex-col flex-1 gap-1">
                          <Label
                            htmlFor="product-price"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            Price
                          </Label>
                          <Input
                            id="product-price"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            value={price}
                            onChange={(e) => {
                              const next = e.target.value;
                              setPrice(next);
                              if (defaultVariant) {
                                patchVariantDraft(defaultVariant, { price: next });
                              }
                            }}
                            disabled={!defaultVariant}
                          />
                        </div>
                        <div className="flex flex-col flex-1 gap-1">
                          <Label
                            htmlFor="product-compare-at-price"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            Compare at price
                          </Label>
                          <Input
                            id="product-compare-at-price"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            value={compareAtPrice}
                            onChange={(e) => setCompareAtPrice(e.target.value)}
                            disabled={!defaultVariant}
                          />
                        </div>
                        <div className="flex flex-col flex-1 gap-1">
                          <Label
                            htmlFor="product-cost"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            Cost per item
                          </Label>
                          <Input
                            id="product-cost"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            value={cost}
                            onChange={(e) => {
                              const next = e.target.value;
                              setCost(next);
                              if (defaultVariant) {
                                patchVariantDraft(defaultVariant, { cost: next });
                              }
                            }}
                            disabled={!defaultVariant}
                          />
                        </div>
                      </div>
                      <div className="flex flex-row gap-6 items-center justify-between rounded-lg">
                        <div className="flex flex-col flex-1 gap-1 bg-[#f5f5f5] p-2 rounded-lg dark:bg-gray-800/60">
                          <Label className="text-[12px] font-medium text-muted-foreground">
                            Margin
                          </Label>
                          <span className="text-[12px] font-medium text-muted-foreground">
                            {pricingMargin
                              ? `${pricingMargin.marginPct.toFixed(0)}%`
                              : "—"}
                          </span>
                        </div>
                        <div className="flex flex-col flex-1 gap-1 bg-[#f5f5f5] p-2 rounded-lg dark:bg-gray-800/60">
                          <Label className="text-[12px] font-medium text-muted-foreground">
                            Profit per item
                          </Label>
                          <span className="text-[12px] font-medium text-muted-foreground">
                            {pricingMargin
                              ? formatCurrency(pricingMargin.profit, currency)
                              : "—"}
                          </span>
                        </div>
                      </div>
                      <Separator />
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel className="text-[13px]" htmlFor="product-taxable">
                            Charge tax on this product
                          </FieldLabel>
                          <FieldDescription className="text-[10px]">
                            Applies your store&apos;s default tax rate.
                          </FieldDescription>
                        </FieldContent>
                        <Switch
                          id="product-taxable"
                          checked={taxable}
                          onCheckedChange={setTaxable}
                          disabled={!defaultVariant}
                        />
                      </Field>
                    </div>
                  </div>
                </Section>
              )}

              {isSimpleProduct && (
                <Section title="Inventory">
                  <div className="space-y-4">
                    <div className="space-y-3">
                      <div className="flex flex-row justify-between gap-2">
                        <div className="flex flex-col flex-1 gap-1">
                          <Label
                            htmlFor="product-sku"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            SKU
                          </Label>
                          <Input
                            id="product-sku"
                            placeholder="SKU"
                            value={sku}
                            onChange={(e) => {
                              const next = e.target.value;
                              setSku(next);
                              if (defaultVariant) {
                                patchVariantDraft(defaultVariant, { sku: next });
                              }
                            }}
                            disabled={!defaultVariant}
                          />
                        </div>
                        <div className="flex flex-col flex-1 gap-1">
                          <Label
                            htmlFor="product-barcode"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            Barcode
                          </Label>
                          <Input
                            id="product-barcode"
                            placeholder="Barcode"
                            value={barcode}
                            onChange={(e) => setBarcode(e.target.value)}
                            disabled={!defaultVariant}
                          />
                        </div>
                      </div>

                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel className="text-[13px]" htmlFor="product-track-quantity">
                            Track quantity
                          </FieldLabel>
                          {trackForced && (
                            <FieldDescription className="text-[11px] text-amber-700 dark:text-amber-300">
                              Forced ON for all products in{" "}
                              <Link to="/settings" className="underline">Settings → Sync</Link>.
                            </FieldDescription>
                          )}
                        </FieldContent>
                        <Switch
                          id="product-track-quantity"
                          checked={trackForced ? true : trackQuantity}
                          onCheckedChange={setTrackQuantity}
                          disabled={!defaultVariant || trackForced}
                        />
                      </Field>

                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel
                            className="text-[13px]"
                            htmlFor="product-continue-selling"
                          >
                            Continue selling when out of stock
                          </FieldLabel>
                          {oversellForced && (
                            <FieldDescription className="text-[11px] text-amber-700 dark:text-amber-300">
                              Forced ON for all products in{" "}
                              <Link to="/settings" className="underline">Settings → Sync</Link>.
                              Shopify receives "continue" regardless of this switch.
                            </FieldDescription>
                          )}
                        </FieldContent>
                        <Switch
                          id="product-continue-selling"
                          checked={oversellForced ? true : continueSelling}
                          onCheckedChange={setContinueSelling}
                          disabled={!defaultVariant || oversellForced}
                        />
                      </Field>

                      {/* Committed and On hand used to sit here: Committed was
                          hard-coded to a dash (nothing writes the reserved
                          bucket yet) and On hand simply echoed whatever was
                          typed into Available, so neither told the truth.
                          They come back when reservations do. */}
                      <div className="flex flex-row gap-2 items-center justify-between">
                        <div className="flex flex-col flex-1 gap-1 bg-[#f5f5f5] p-2 rounded-lg dark:bg-gray-800/60">
                          <Label
                            htmlFor="product-inventory-available"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            {STOCK_TERMS.available.label}
                            {warehousingEnabled && " · all locations"}
                          </Label>
                          {!trackQuantity ? (
                            <span className="text-[12px] font-medium text-muted-foreground">
                              Not tracked
                            </span>
                          ) : warehousingEnabled ? (
                            // Read-only on purpose. Stock is held per location
                            // here, and the save path drops a bare quantity —
                            // an editable box was accepting input and silently
                            // discarding it.
                            <div className="flex items-baseline gap-2">
                              <span className="text-[12px] font-semibold text-foreground tabular-nums">
                                {inventoryQuantity || "0"}
                              </span>
                              <Link
                                to={`/products/inventory?search=${encodeURIComponent(product?.title ?? "")}`}
                                className="text-[12px] font-medium text-brand-strong underline underline-offset-2 hover:no-underline"
                              >
                                Edit per location
                              </Link>
                            </div>
                          ) : (
                            <Input
                              id="product-inventory-available"
                              type="number"
                              inputMode="numeric"
                              min="0"
                              step="1"
                              className="h-8 bg-white dark:bg-gray-900"
                              value={inventoryQuantity}
                              onChange={(e) => {
                                const next = e.target.value;
                                setInventoryQuantity(next);
                                if (defaultVariant) {
                                  patchVariantDraft(defaultVariant, {
                                    inventoryQuantity: next,
                                  });
                                }
                              }}
                              disabled={!defaultVariant}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </Section>
              )}

              {isSimpleProduct && (
                <Section title="Shipping">
                  <div className="space-y-4">
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel className="text-[13px]" htmlFor="product-physical">
                          This is a physical product
                        </FieldLabel>
                        <FieldDescription className="text-[11px]">
                          Off for digital downloads, services, etc.
                        </FieldDescription>
                      </FieldContent>
                      <Switch
                        id="product-physical"
                        checked={requiresShipping}
                        onCheckedChange={setRequiresShipping}
                        disabled={!defaultVariant}
                      />
                    </Field>
                    {requiresShipping && (
                      <div className="flex flex-row gap-2">
                        <div className="flex flex-col flex-1 gap-1">
                          <Label
                            htmlFor="product-weight"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            Weight
                          </Label>
                          <Input
                            id="product-weight"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            placeholder="0.0"
                            className="h-8 bg-white dark:bg-gray-900"
                            value={weight}
                            onChange={(e) => setWeight(e.target.value)}
                            disabled={!defaultVariant}
                          />
                        </div>
                        <div className="flex flex-col w-28 gap-1">
                          <Label
                            htmlFor="product-weight-unit"
                            className="text-[12px] font-medium text-muted-foreground"
                          >
                            Unit
                          </Label>
                          <select
                            id="product-weight-unit"
                            value={weightUnit}
                            onChange={(e) => setWeightUnit(e.target.value)}
                            disabled={!defaultVariant}
                            className="h-8 w-full rounded-md border border-input bg-white dark:bg-gray-900 px-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                          >
                            <option value="g">g</option>
                            <option value="kg">kg</option>
                            <option value="oz">oz</option>
                            <option value="lb">lb</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {isSimpleProduct && (
                <Section title="Customs">
                  <div className="flex flex-row gap-2">
                    <div className="flex flex-col flex-1 gap-1">
                      <Label
                        htmlFor="product-hs-code"
                        className="text-[12px] font-medium text-muted-foreground"
                      >
                        HS code (customs, for Shopify shipping)
                      </Label>
                      <Input
                        id="product-hs-code"
                        placeholder="6109.10"
                        className="h-8 bg-white dark:bg-gray-900 font-mono"
                        value={hsCode}
                        onChange={(e) => setHsCode(e.target.value)}
                        disabled={!defaultVariant}
                      />
                    </div>
                    <div className="flex flex-col flex-1 gap-1">
                      <Label
                        htmlFor="product-country"
                        className="text-[12px] font-medium text-muted-foreground"
                      >
                        Country of origin
                      </Label>
                      <Input
                        id="product-country"
                        placeholder="IN"
                        maxLength={2}
                        className="h-8 bg-white dark:bg-gray-900 font-mono uppercase"
                        value={countryOfOrigin}
                        onChange={(e) => setCountryOfOrigin(e.target.value.toUpperCase())}
                        disabled={!defaultVariant}
                      />
                      <span className="text-[11px] text-muted-foreground">
                        Two-letter ISO code
                      </span>
                    </div>
                  </div>
                </Section>
              )}

            </>
          )}

          {activeTab === "variants" && (
            <>
              <VariantOptionsCard
                options={options}
                valueDrafts={optionValueDrafts}
                committedOptionNames={(product.options ?? []).map((o) => o.name)}
                variants={product.variants}
                isDirty={isOptionsDirty}
                isSaving={
                  updateOptionsMutation.isPending ||
                  generateVariantsMutation.isPending
                }
                isSyncedToShopify={!!sync}
                onAddOption={handleAddOption}
                onRemoveOption={handleRemoveOption}
                onOptionNameChange={handleOptionNameChange}
                onValueDraftChange={(index, value) =>
                  setOptionValueDrafts((prev) =>
                    prev.map((draft, i) => (i === index ? value : draft)),
                  )
                }
                onAddValue={handleAddOptionValue}
                onRemoveValue={handleRemoveOptionValue}
                onSaveAndGenerate={handleSaveAndGenerate}
              />

              <VariantPriceStockCard
                productTitle={product.title}
                productImages={galleryImages}
                productStatus={product.status}
                variants={product.variants}
                committedOptions={product.options ?? []}
                // A catalogue price is in the CHANNEL's currency, not the org's
                // — a Shopify store selling in USD must not render as ₹.
                currency={product.channel?.currency ?? currency}
                drafts={variantDrafts}
                productTax={{
                  hsnCode: product.hsnCode ?? null,
                  gstRate: toGstRateOption(product.gstRate),
                  unitOfMeasure: product.unitOfMeasure ?? null,
                  supplyType: product.supplyType ?? "TAXABLE",
                }}
                onSaveVariant={handleSaveVariant}
                onVariantPersisted={handleVariantPersisted}
                isSavingVariant={updateVariantMutation.isPending}
                warehousingEnabled={warehousingEnabled}
                trackForced={trackForced}
                oversellForced={oversellForced}
                isVendor={isVendor}
              />
            </>
          )}

          {activeTab === "orders" && (
            <Section
              title={`Recent sales${recentOrders?.meta?.total ? ` (${recentOrders.meta.total} total)` : ""
                }`}
            >
              {recentOrders?.data?.length ? (
                <ul className="divide-y">
                  {recentOrders.data.map((o) => (
                    <li key={o.id}>
                      <Link
                        to={`/orders/${o.id}`}
                        className="-mx-5 flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                      >
                        <div>
                          <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
                            {o.name}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {o.customer
                              ? `${o.customer.firstName ?? ""} ${o.customer.lastName ?? ""}`.trim() || "Guest"
                              : "Guest"}{" "}
                            • {formatDate(o.createdAt)}
                          </p>
                        </div>
                        <p className="text-xs tabular-nums font-semibold">
                          {formatCurrency(o.totalPrice, currency)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No orders include this product yet.
                </p>
              )}
            </Section>
          )}

          {activeTab === "channels" && (
            <>
              <Section title="Channel">
                <dl className="space-y-1.5 text-xs">
                  <DescRow label="Channel name" value={product.channel?.name ?? "—"} />
                  <DescRow label="Platform" value={product.channel?.platform ?? "—"} />
                  <DescRow label="Total stock" value={String(totalStock)} icon={<Package className="size-3" />} />
                  <DescRow label="Variants" value={String(product.variants.length)} />
                </dl>
              </Section>
              {sync && (
                <Section title="Shopify Sync">
                  <ShopifySyncCard sync={sync} productId={product.id} />
                </Section>
              )}
            </>
          )}

          {activeTab === "insights" && (
            <Section title="Insights">
              <p className="text-xs text-muted-foreground italic">
                Product insights and analytics will appear here.
              </p>
            </Section>
          )}

          {activeTab === "seo" && (
            <Section title="SEO">
              <dl className="space-y-1.5 text-xs">
                <DescRow label="Product title" value={product.title} />
                <DescRow
                  label="Tags"
                  value={product.tags?.length ? product.tags.join(", ") : "—"}
                />
              </dl>
              <p className="mt-3 text-xs text-muted-foreground italic">
                Advanced SEO fields coming soon.
              </p>
            </Section>
          )}
        </div>
        {/* Right side */}
        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          {/* Stock summary */}

          <Section title="Status">
            <div className="space-y-3">
              <div className="flex flex-col gap-5 items-start  justify-between">
                <Combobox
                  items={[...STATUS_OPTIONS]}
                  value={STATUS_LABEL[status]}
                  onValueChange={(label) => {
                    const next = STATUS_VALUE[label ?? ""];
                    if (next) setStatus(next);
                  }}
                >
                  <ComboboxInput
                    placeholder="Select status"
                    className="w-full"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>No items found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item) => (
                        <ComboboxItem key={item} value={item}>
                          {item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>

              </div>
              <Separator className="my-3" />
              <div className="flex gap-2 items-start justify-between">
                <p className="text-[12px]">Published on: </p>
                <span className="font-medium text-[12px]">
                  {formatDate(product.publishedAt ?? product.createdAt)}
                </span>
              </div>
              <div className="flex gap-2 items-start justify-between">
                <p className="text-[12px]">Last updated: </p>
                <span className="font-medium text-[12px]">
                  {formatDate(product.updatedAt ?? product.createdAt)}
                </span>
              </div>
            </div>
          </Section>


          <Section title="Tax (GST)">
            <div className="space-y-3 text-xs">
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="product-hsn"
                  className="text-[12px] font-medium text-muted-foreground"
                >
                  HSN / SAC code
                </Label>
                <Input
                  id="product-hsn"
                  placeholder="6109"
                  className="h-8 bg-white dark:bg-gray-900 font-mono"
                  value={hsnCode}
                  onChange={(e) => setHsnCode(e.target.value)}
                  disabled={isVendor}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="product-gst-rate"
                  className="text-[12px] font-medium text-muted-foreground"
                >
                  GST rate
                </Label>
                <select
                  id="product-gst-rate"
                  value={gstRate}
                  onChange={(e) => setGstRate(e.target.value)}
                  disabled={isVendor}
                  className="h-8 w-full rounded-md border border-input bg-white dark:bg-gray-900 px-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                >
                  <option value="">Not set</option>
                  {GST_RATE_OPTIONS.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}%
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="product-uqc"
                  className="text-[12px] font-medium text-muted-foreground"
                >
                  Unit of measure (UQC)
                </Label>
                <select
                  id="product-uqc"
                  value={unitOfMeasure}
                  onChange={(e) => setUnitOfMeasure(e.target.value)}
                  disabled={isVendor}
                  className="h-8 w-full rounded-md border border-input bg-white dark:bg-gray-900 px-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                >
                  <option value="">Default (NOS)</option>
                  {COMMON_UQC.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="product-supply-type"
                  className="text-[12px] font-medium text-muted-foreground"
                >
                  Supply type
                </Label>
                <select
                  id="product-supply-type"
                  value={supplyType}
                  onChange={(e) => setSupplyType(e.target.value as GstSupplyType)}
                  disabled={isVendor}
                  className="h-8 w-full rounded-md border border-input bg-white dark:bg-gray-900 px-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-[#CEF17B]/50"
                >
                  {GST_SUPPLY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Applies to every variant unless a variant sets its own override
                in the variant editor.
              </p>
              {isVendor && (
                <p className="text-[11px] text-muted-foreground">
                  Tax fields are managed by the store owner.
                </p>
              )}
            </div>
          </Section>

          <Section title="Product Organization">
            <dl className="space-y-3 text-xs">
              <ComboboxField
                label="Product Type"
                items={typeItems}
                value={productType}
                onChange={setProductType}
                placeholder="Select product type"
              />
              <ComboboxField
                label="Vendor"
                items={vendorItems}
                value={vendor}
                onChange={setVendor}
                placeholder="Select vendor"
                disabled={isVendor}
              />
              <TagsComboboxField
                label="Tags"
                items={tagItems}
                value={tags}
                onChange={setTags}
              />

            </dl>
          </Section>


          <Section title="At Glance">
            <dl className="space-y-1.5 text-xs flex flex-col gap-[6px]">
              <DescRow label="Orders" value={String(ordersCount)} />
              <DescRow label="Variants" value={String(variantsCount)} />
              <DescRow label="In stock" value={String(totalStock)} />
              <DescRow
                label="Live channels"
                value={
                  liveChannelsCount > 0
                    ? `${liveChannelsCount}${product.channel?.name ? ` (${product.channel.name})` : ""}`
                    : "0"
                }
              />
            </dl>
          </Section>

        </div>
      </div>

      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You have unsaved changes on this product. If you leave now they
            will be lost.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => blocker.proceed?.()}
            >
              Discard and leave
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div >
  );
}

function ShopifySyncCard({
  sync,
  productId,
}: {
  sync: Pick<ProductShopifySync, "status" | "shopifyProductId" | "error">;
  productId: string;
}) {
  const syncMutation = useSyncProductMutation();
  // Same action as the list page's cloud icon. The card used to tell the
  // merchant to "click Sync to Shopify" while the only button lived on the
  // list — so an out-of-sync product had no way to push from its own page.
  const syncButton = (
    <button
      type="button"
      disabled={syncMutation.isPending}
      onClick={() => syncMutation.mutate(productId)}
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
    >
      {syncMutation.isPending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <UploadCloud className="size-3.5" />
      )}
      {sync.status === "FAILED" ? "Retry sync" : "Sync to Shopify"}
    </button>
  );

  if (sync.status === "SYNCED") {
    return (
      <div className="space-y-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">
          <Check className="size-3" />
          Synced
        </span>
        {sync.shopifyProductId && (
          <p className="text-[10px] text-muted-foreground">
            Shopify ID: <span className="font-mono">{sync.shopifyProductId}</span>
          </p>
        )}
      </div>
    );
  }
  if (sync.status === "PENDING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
        <Loader2 className="size-3 animate-spin" />
        Syncing
      </span>
    );
  }
  if (sync.status === "OUT_OF_SYNC") {
    return (
      <div className="space-y-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-3" />
          Out of sync
        </span>
        <p className="text-[10px] text-muted-foreground">
          Local edits haven't been pushed yet.
        </p>
        {syncButton}
      </div>
    );
  }
  return (
    <div className="space-y-2 text-xs">
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-900/30 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
        <AlertTriangle className="size-3" />
        Sync failed
      </span>
      {sync.error && <p className="text-[10px] text-red-700 dark:text-red-400">{sync.error}</p>}
      {syncButton}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[6px] bg-white dark:bg-gray-900 shadow-sm ring-1 ring-border">
      <h2 className="border-b px-5 py-3 text-[14px] font-semibold  tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function TagsComboboxField({
  label,
  items,
  value,
  onChange,
  placeholder = "Add tags…",
}: {
  label: string;
  items: string[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const anchor = useComboboxAnchor();
  const createInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [newValue, setNewValue] = useState("");

  useEffect(() => {
    if (!open || !createMode) return;
    const scrollY = window.scrollY;
    const frame = requestAnimationFrame(() => {
      createInputRef.current?.focus({ preventScroll: true });
      window.scrollTo(0, scrollY);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, createMode]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setCreateMode(false);
      setNewValue("");
    }
  }

  function handleAddClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCreateMode(true);
    // Defer open so this click isn't treated as an outside dismiss.
    queueMicrotask(() => setOpen(true));
  }

  function commitNewValue() {
    const next = newValue.trim();
    if (!next) return;
    if (!value.includes(next)) onChange([...value, next]);
    setOpen(false);
    setCreateMode(false);
    setNewValue("");
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground text-[12px]">{label}</dt>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={handleAddClick}
          aria-label={`Add ${label.toLowerCase()}`}
          className="rounded-full p-0.5 text-muted-foreground hover:bg-muted"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <g strokeWidth="0" />
            <g strokeLinecap="round" strokeLinejoin="round" />
            <g
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 12h5m0 0h5m-5 0V7m0 5v5" />
              <circle cx="12" cy="12" r="9" />
            </g>
          </svg>
        </button>
      </div>
      <dd>
        <Combobox
          multiple
          autoHighlight
          items={items}
          value={value}
          onValueChange={(next) => onChange(next ?? [])}
          open={open}
          onOpenChange={handleOpenChange}
        >
          <ComboboxChips ref={anchor} className="w-full">
            <ComboboxValue>
              {(values) => (
                <>
                  {values.map((tag: string) => (
                    <ComboboxChip key={tag}>{tag}</ComboboxChip>
                  ))}
                  <ComboboxChipsInput placeholder={placeholder} />
                </>
              )}
            </ComboboxValue>
          </ComboboxChips>
          <ComboboxContent anchor={anchor}>
            {createMode && (
              <div
                className="flex items-center gap-1.5 border-b p-2"
                onMouseDown={(e) => e.preventDefault()}
              >
                <Input
                  ref={createInputRef}
                  value={newValue}
                  placeholder={`Add new ${label.toLowerCase()}…`}
                  className="h-8"
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      commitNewValue();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 px-2 text-xs"
                  onClick={commitNewValue}
                  disabled={!newValue.trim()}
                >
                  Add
                </Button>
              </div>
            )}
            <ComboboxEmpty>No tags found.</ComboboxEmpty>
            <ComboboxList>
              {(item) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </dd>
    </div>
  );
}

function ComboboxField({
  label,
  items,
  value,
  onChange,
  placeholder,
  disabled = false,
  hideAddButton = false,
}: {
  label: string;
  items: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  hideAddButton?: boolean;
}) {
  const createInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [newValue, setNewValue] = useState("");

  useEffect(() => {
    if (!open || !createMode) return;
    const scrollY = window.scrollY;
    const frame = requestAnimationFrame(() => {
      createInputRef.current?.focus({ preventScroll: true });
      window.scrollTo(0, scrollY);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, createMode]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setCreateMode(false);
      setNewValue("");
    }
  }

  function handleAddClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    setCreateMode(true);
    // Defer open so this click isn't treated as an outside dismiss.
    queueMicrotask(() => setOpen(true));
  }

  function commitNewValue() {
    const next = newValue.trim();
    if (!next) return;
    onChange(next);
    setOpen(false);
    setCreateMode(false);
    setNewValue("");
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground text-[12px]">{label}</dt>
        {!hideAddButton && !disabled && (
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={handleAddClick}
            aria-label={`Add ${label.toLowerCase()}`}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-muted"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <g strokeWidth="0" />
              <g strokeLinecap="round" strokeLinejoin="round" />
              <g
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 12h5m0 0h5m-5 0V7m0 5v5" />
                <circle cx="12" cy="12" r="9" />
              </g>
            </svg>
          </button>
        )}
      </div>
      <dd>
        <Combobox
          items={items}
          value={value || null}
          onValueChange={(next) => onChange(next ?? "")}
          disabled={disabled}
          open={open}
          onOpenChange={handleOpenChange}
        >
          <ComboboxInput placeholder={placeholder} />
          <ComboboxContent>
            {createMode && (
              <div
                className="flex items-center gap-1.5 border-b p-2"
                onMouseDown={(e) => e.preventDefault()}
              >
                <Input
                  ref={createInputRef}
                  value={newValue}
                  placeholder={`Add new ${label.toLowerCase()}…`}
                  className="h-8"
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      commitNewValue();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 px-2 text-xs"
                  onClick={commitNewValue}
                  disabled={!newValue.trim()}
                >
                  Add
                </Button>
              </div>
            )}
            <ComboboxEmpty>No items found.</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </dd>
    </div>
  );
}

function DescRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="inline-flex items-center gap-1.5 text-muted-foreground text-[13px]">
        {icon}
        {label}
      </dt>
      <dd className="font-medium text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}
