import { useEffect } from "react";
import { useParams } from "react-router";
import { isAxiosError } from "axios";
import { Loader2, PackageCheck, ShoppingCart } from "lucide-react";

import { PublicLinkMessage } from "~/components/app/public-link-message";
import { usePublicCartLink } from "~/hooks/use-public-links";

export function meta() {
  return [{ title: "Your cart" }, { name: "robots", content: "noindex" }];
}

/** The store's own checkout, and nothing else: the server sends it only when it is https. */
const checkoutUrl = (url: string | null) => (url && /^https:\/\//i.test(url) ? url : null);

/**
 * A shopper's saved cart, from the "Return to cart" button in a WhatsApp
 * reminder. Public: the token in the link is the only key. It goes straight
 * to the store's checkout; a cart that became an order, or a link that no
 * longer leads anywhere, says so instead.
 */
export default function PublicCartPage() {
  const { token } = useParams<{ token: string }>();
  const { data, error, isLoading, refetch, isFetching } = usePublicCartLink(token);
  const checkout = data && !data.completed ? checkoutUrl(data.url) : null;

  useEffect(() => {
    if (checkout) window.location.replace(checkout);
  }, [checkout]);
  useEffect(() => {
    if (data) document.title = `Your cart · ${data.storeName}`;
  }, [data]);

  const status = isAxiosError(error) ? (error.response?.status ?? 0) : 0;
  const refused = status >= 400 && status < 500;

  return (
    <div className="min-h-dvh bg-surface-sunken px-4 py-10">
      <main className="mx-auto max-w-md">
        {isLoading || checkout ? (
          <div className="flex flex-col items-center gap-3 pt-16 text-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-body">{data ? `Taking you back to your cart at ${data.storeName}…` : "Opening your cart…"}</p>
            {checkout && (
              <a href={checkout} className="text-caption text-muted-foreground underline">
                Open it now
              </a>
            )}
          </div>
        ) : data?.completed ? (
          <PublicLinkMessage icon={PackageCheck} title="This order was placed" body={`Thank you for shopping with ${data.storeName}. The store has your order.`} />
        ) : data ? (
          <PublicLinkMessage icon={ShoppingCart} title="This cart link isn't valid." body={`The cart may have expired. Ask ${data.storeName} on WhatsApp for a new link.`} />
        ) : (
          <PublicLinkMessage
            icon={ShoppingCart}
            title={refused ? "This cart link isn't valid." : "Your cart couldn't be opened"}
            body={refused ? "It may have expired, or part of it is missing." : "Check your internet connection and try again."}
            retry={refused ? undefined : { onClick: () => void refetch(), busy: isFetching }}
          />
        )}
      </main>
    </div>
  );
}
