/**
 * The {{placeholders}} an automation's messages are written with, as words a
 * store owner reads on the canvas: "Your order {{order.name}} has shipped"
 * reads "Your order ‹order number› has shipped". The editor keeps the
 * placeholders; only the summaries change. Pure, so it is unit-tested.
 */
const LABELS: Record<string, string> = {
  first_name: "first name",
  last_name: "last name",
  name: "name",
  phone: "phone number",
  email: "email",
  last_reply: "their last reply",
  "order.name": "order number",
  "order.total": "order total",
  "order.status": "order status",
  "order.tracking_url": "tracking link",
  "order.tracking_number": "tracking number",
  "checkout.url": "checkout link",
  "checkout.total": "cart total",
  "payment.amount": "amount paid",
  "refund.amount": "refund amount",
  "ad.headline": "ad headline",
  "ad.body": "ad text",
  "signup.name": "sign-up name",
  "signup.page": "sign-up page",
};

export function readableVariables(text: string): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => `‹${LABELS[key] ?? key.replace(/[._]+/g, " ")}›`);
}
