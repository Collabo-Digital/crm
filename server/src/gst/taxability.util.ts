import { GstSupplyType } from '@prisma/client';

/**
 * Whether a sale line attracts GST at all.
 *
 * `OrderLineItem.taxable` and `ProductVariant.taxable` both exist, both default
 * `true`, and until now NO tax path read either — so a line explicitly marked
 * non-taxable was still taxed at the resolved rate, on the order and on the
 * statutory invoice.
 *
 * SEMANTICS: `false` on EITHER flag exempts the line. Absent or null means
 * taxable, matching the column default — deliberately not "both must be true",
 * because a Shopify line whose variant relation did not resolve would then be
 * silently exempted, turning a data-loading gap into an under-declaration.
 */
export interface LineTaxabilityInput {
    /** OrderLineItem.taxable / DraftOrderLineItem.taxable */
    lineTaxable?: boolean | null;
    /** ProductVariant.taxable */
    variantTaxable?: boolean | null;
    /**
     * Statutory classification from `resolveLineTaxClassification`. Only a
     * TAXABLE supply attracts output tax — zero-rated, nil-rated, exempt and
     * non-GST supplies all carry none, by definition rather than by rate.
     *
     * Absent means "not classified", which stays taxable: the flags above are
     * then the only signal, matching the behaviour before this was threaded
     * through. Callers that DO classify must pass it, or an export gets a rate.
     */
    supplyType?: GstSupplyType | null;
}

export function isLineTaxable(input: LineTaxabilityInput): boolean {
    // Checked first, and it is the reason exports were taxed: an export is
    // ZERO_RATED from its place of supply, but nothing carried that fact into
    // rate resolution, so the chain handed it the goods' ordinary 18% — an
    // invoice charging ₹266.38 of IGST the sales channel never collected.
    //
    // Under an LUT an export is zero-rated WITHOUT payment of tax, which is
    // what 0% here expresses. An exporter shipping ON PAYMENT of IGST instead
    // would need this to become a setting rather than a constant.
    if (input.supplyType != null && input.supplyType !== GstSupplyType.TAXABLE) {
        return false;
    }
    if (input.lineTaxable === false) return false;
    if (input.variantTaxable === false) return false;
    return true;
}
