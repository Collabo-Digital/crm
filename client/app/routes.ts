import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  layout("routes/auth/_layout.tsx", [
    route("auth/login", "routes/auth/login.tsx"),
    route("auth/signup", "routes/auth/signup.tsx"),
    route("auth/verify-email", "routes/auth/verify-email.tsx"),
    route("auth/forgot-password", "routes/auth/forgot-password.tsx"),
    route("auth/reset-password", "routes/auth/reset-password.tsx"),
    route("auth/invite", "routes/auth/invite.tsx"),
  ]),

  layout("routes/onboarding/_layout.tsx", [
    route("onboarding/choose-plan", "routes/onboarding/choose-plan.tsx"),
    route("onboarding/account-type", "routes/onboarding/account-type.tsx"),
    route("onboarding/create-organization", "routes/onboarding/create-organization.tsx"),
    route("onboarding/invite-team", "routes/onboarding/invite-team.tsx"),
  ]),

  layout("routes/app/_layout.tsx", [
    route("dashboard", "routes/app/dashboard.tsx"),
    // Orders section. Drafts / Customers / Invoices live under /orders/* so the
    // navbar can present them as one section. Static segments outrank ":id" in
    // React Router's route ranking, so "orders/drafts" never hits "orders/:id".
    route("orders", "routes/app/orders.tsx"),
    route("orders/new", "routes/app/orders/new.tsx"),
    route("orders/drafts", "routes/app/orders/drafts.tsx"),
    route("orders/drafts/new", "routes/app/orders/drafts/new.tsx"),
    route("orders/drafts/:id", "routes/app/orders/drafts/$id.tsx"),
    route("orders/customers", "routes/app/orders/customers.tsx"),
    route("orders/customers/:id", "routes/app/orders/customers/$id.tsx"),
    route("orders/invoices", "routes/app/orders/invoices.tsx"),
    route("orders/invoices/:id", "routes/app/orders/invoices/$id.tsx"),
    route("orders/invoices/:id/print", "routes/app/orders/invoices/print.tsx"),
    // Batch package slips, N-up. Static "slips" outranks ":id", and ending in
    // /print is what makes the app layout render it chrome-free.
    route("orders/slips/print", "routes/app/orders/slips-print.tsx"),
    route("orders/:id", "routes/app/orders/$id.tsx"),
    route("orders/:id/packing-slip", "routes/app/orders/packing-slip.tsx"),
    route("orders/:id/pick-slip", "routes/app/orders/pick-slip.tsx"),

    // Pre-move URLs. The splat also matches zero segments, so bare "/drafts"
    // redirects as well as "/drafts/<id>".
    route("drafts/*", "routes/app/legacy-redirect.tsx", { id: "legacy-drafts" }),
    route("customers/*", "routes/app/legacy-redirect.tsx", { id: "legacy-customers" }),
    route("invoices/*", "routes/app/legacy-redirect.tsx", { id: "legacy-invoices" }),
    route("inventory/*", "routes/app/legacy-redirect.tsx", { id: "legacy-inventory" }),
    route("channel/*", "routes/app/legacy-redirect.tsx", { id: "legacy-channel" }),
    // The nav label and page title were always "Campaigns"; only the URL said
    // "marketing". Renamed before three more URLs got built on top of it.
    route("marketing/*", "routes/app/legacy-redirect.tsx", { id: "legacy-marketing" }),
    // Products section. Inventory (and its ledger / warehouses / label sheets)
    // lives under /products/* so the navbar can present them as one section.
    route("products", "routes/app/products.tsx"),
    route("products/inventory", "routes/app/products/inventory.tsx"),
    route("products/inventory/ledger", "routes/app/products/inventory/ledger.tsx"),
    route("products/inventory/warehouses", "routes/app/products/inventory/warehouses.tsx"),
    // Ends in /print → the app layout renders it chrome-free (same regex as
    // packing-slip / pick-slip / invoice print).
    route("products/inventory/labels/print", "routes/app/products/inventory/labels-print.tsx"),
    route("products/:id", "routes/app/products/$id.tsx"),
    // Inbox section: WhatsApp, Messenger and Instagram conversations, and the
    // contacts behind them. The old preview lived at /conversation.
    route("inbox", "routes/app/inbox.tsx"),
    route("inbox/contacts", "routes/app/inbox/contacts.tsx"),
    route("conversation/*", "routes/app/legacy-redirect.tsx", { id: "legacy-conversation" }),
    // Campaigns section: WhatsApp broadcasts, templates and segments. Static
    // segments ("new") outrank ":id".
    route("campaigns", "routes/app/campaigns.tsx"),
    route("campaigns/broadcasts", "routes/app/campaigns/broadcasts.tsx"),
    route("campaigns/broadcasts/new", "routes/app/campaigns/broadcasts/new.tsx"),
    route("campaigns/broadcasts/:id", "routes/app/campaigns/broadcasts/$id.tsx"),
    route("campaigns/templates", "routes/app/campaigns/templates.tsx"),
    route("campaigns/templates/new", "routes/app/campaigns/templates/new.tsx"),
    route("campaigns/templates/:id", "routes/app/campaigns/templates/$id.tsx"),
    route("campaigns/segments", "routes/app/campaigns/segments.tsx"),
    route("campaigns/segments/new", "routes/app/campaigns/segments/$id.tsx", { id: "campaigns-segment-new" }),
    route("campaigns/segments/:id", "routes/app/campaigns/segments/$id.tsx"),
    route("campaigns/catalog", "routes/app/campaigns/catalog.tsx"),
    route("campaigns/automations", "routes/app/campaigns/automations.tsx"),
    route("campaigns/automations/starters", "routes/app/campaigns/automations/starters.tsx"),
    route("campaigns/automations/:id", "routes/app/campaigns/automations/$id.tsx"),
    // Logistics is not on this branch. Its old URLs fall through
    // legacy-redirect to the landing page rather than the bare 404.
    route("logistics/*", "routes/app/legacy-redirect.tsx", { id: "removed-logistics" }),
    // A visual preview with no backend yet.
    route("analytics", "routes/app/analytics.tsx"),
    route("analytics/messaging", "routes/app/analytics/messaging.tsx"),
    route("profile", "routes/app/profile.tsx"),
    route("settings", "routes/app/settings.tsx"),
    route("settings/:tab", "routes/app/settings.tsx", { id: "settings-tab" }),
    // Super admin (Collabo team only) — guarded inside the route components.
    route("admin/users", "routes/app/admin/users.tsx"),
    route("admin/users/:userId", "routes/app/admin/user-detail.tsx"),
  ]),
] satisfies RouteConfig;
