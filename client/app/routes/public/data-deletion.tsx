import { useSearchParams } from "react-router";
import { CircleCheck } from "lucide-react";

import { LegalPage, LegalSection, SupportEmail } from "~/components/app/legal-page";

export function meta() {
  return [{ title: "Data deletion · Collabo" }];
}

/**
 * How to have Collabo delete your data. Meta's Data deletion callback answers
 * with this page plus `?code=`, the confirmation code it shows the person who
 * asked; the deletion itself already ran in that callback.
 */
export default function DataDeletionPage() {
  const [params] = useSearchParams();
  const code = (params.get("code") ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 32);

  return (
    <LegalPage title="Data deletion" updated="4 November 2026">
      {code && (
        <div className="flex gap-3 rounded-xl bg-success-subtle p-4 text-foreground">
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" />
          <div className="space-y-1">
            <p className="font-medium">Your request has been completed</p>
            <p className="text-caption">
              Confirmation code <span className="font-mono">{code}</span>. We deleted the access token Collabo held for your
              Instagram account and disconnected it from every Collabo workspace. Quote this code if
              you contact us about the request.
            </p>
          </div>
        </div>
      )}

      <LegalSection title="Instagram">
        <ul>
          <li>
            In Collabo, open Settings → Channels and disconnect the account; or, in Instagram, go to Settings → Apps and
            websites and remove Collabo.
          </li>
          <li>
            Either way, Collabo deletes the account's access token straight away and stops receiving its messages and
            comments.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="WhatsApp">
        <p>In Collabo, open Settings → Channels and disconnect the number. Collabo deletes its access token straight away.</p>
      </LegalSection>

      <LegalSection title="Everything else">
        <p>
          To delete your Collabo account and all of its data, including conversation history, contacts and orders, email{" "}
          <SupportEmail /> from your account's email address with the subject "Delete my data". If you are a customer of a
          store that uses Collabo, tell us which store. We confirm by email and complete the deletion within 30 days.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
