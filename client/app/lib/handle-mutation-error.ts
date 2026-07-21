import { isAxiosError } from "axios";
import { toast } from "sonner";

/**
 * Shared error handler for React Query mutation `onError` callbacks.
 *
 * If the error is an Axios error, displays the server-provided message
 * (or the given `fallbackMessage`). For all other errors, displays a
 * generic "Something went wrong" toast.
 *
 * @param error - The error thrown by the mutation function.
 * @param fallbackMessage - Message to show when the server response has no message field.
 */
export function handleMutationError(
  error: unknown,
  fallbackMessage?: string
): void {
  if (isAxiosError(error)) {
    const serverMessage = error.response?.data?.message;
    toast.error(serverMessage || fallbackMessage || "Something went wrong. Please try again.");
  } else {
    toast.error("Something went wrong. Please try again.");
  }
}
