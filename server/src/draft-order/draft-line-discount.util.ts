import type { DraftOrderLineItemInput } from '../channel/shopify-graphql.types';

/**
 * A CRM draft line's discount as Shopify's line `appliedDiscount`.
 *
 * Without it the Shopify draft held the full price, so the invoice link and a
 * completion in Shopify charged the customer more than the CRM quoted.
 *
 * The CRM stores one discount for the whole line, while Shopify's FIXED_AMOUNT
 * line discount is per unit (Shopify multiplies it by the quantity). A total
 * that does not split evenly is rounded UP to the paisa per unit, so Shopify
 * can come out a few paise under the quote but never over it. Never more than
 * the unit price.
 */
export function draftLineAppliedDiscount(
  totalDiscount: number,
  quantity: number,
  unitPrice: number,
): DraftOrderLineItemInput['appliedDiscount'] | undefined {
  if (!(totalDiscount > 0) || !(quantity > 0)) return undefined;
  const perUnitCents = Math.min(
    Math.ceil(Math.round(totalDiscount * 100) / quantity),
    Math.round(unitPrice * 100),
  );
  if (!(perUnitCents > 0)) return undefined;
  return { title: 'Discount', value: perUnitCents / 100, valueType: 'FIXED_AMOUNT' };
}
