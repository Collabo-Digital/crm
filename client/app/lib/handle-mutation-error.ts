import { isAxiosError } from "axios";
import { toast } from "sonner";
import { SessionChangedError } from "~/lib/session-stamp";

/**
 * Shared error handler for React Query mutation `onError` callbacks.
 *
 * If the error is an Axios error, displays the server-provided message
 * (or the given `fallbackMessage`). A request dropped because the account or
 * workspace changed says so. For all other errors, displays a generic
 * "Something went wrong" toast.
 *
 * @param error - The error thrown by the mutation function.
 * @param fallbackMessage - Message to show when the server response has no message field.
 */
export function handleMutationError(
  error: unknown,
  fallbackMessage?: string
): void {
  if (isAxiosError(error)) {
    const data = error.response?.data as
      | { message?: string; errors?: string[] }
      | undefined;
    const base =
      data?.message || fallbackMessage || "Something went wrong. Please try again.";
    const detail =
      Array.isArray(data?.errors) && typeof data.errors[0] === "string"
        ? ` ${data.errors[0]}`
        : "";
    toast.error(base + detail);
  } else if (error instanceof SessionChangedError) {
    toast.error(error.message);
  } else {
    toast.error("Something went wrong. Please try again.");
  }
}

/** The server's own message for a failed request, when it sent one. */
export function serverMessage(error: unknown, fallback: string): string {
  if (!isAxiosError(error)) return fallback;
  const message = (error.response?.data as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}
