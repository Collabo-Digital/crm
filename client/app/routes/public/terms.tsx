import { Link } from "react-router";

import { LEGAL_ENTITY, LegalPage, LegalSection, SupportEmail } from "~/components/app/legal-page";

export function meta() {
  return [{ title: "Terms of service · Collabo" }];
}

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="4 November 2026">
      <p>
        These terms apply to Collabo (app.collabo.store), provided by {LEGAL_ENTITY}, India ("Collabo", "we", "us"). By
        creating an account or using Collabo you agree to them on behalf of yourself and the business you sign up for.
      </p>

      <LegalSection title="Your account">
        <ul>
          <li>You must be at least 18 and give accurate details.</li>
          <li>You are responsible for your login, for the people you invite to your workspace and for what they do in it.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Connected accounts">
        <p>
          When you connect Shopify, Instagram, WhatsApp or another service, you authorise Collabo to act on that account
          as needed for the features you use. You also agree to that service's own terms, including Meta's WhatsApp
          Business and Instagram policies. You can disconnect an account at any time in Settings → Channels.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>You must not use Collabo to:</p>
        <ul>
          <li>send spam, or message people who have not agreed to hear from you;</li>
          <li>send unlawful, misleading or harmful content, or break the rules of a connected platform;</li>
          <li>misuse other people's personal information;</li>
          <li>try to break, overload or get around the security of the service.</li>
        </ul>
        <p>We may suspend an account that does.</p>
      </LegalSection>

      <LegalSection title="Your data">
        <p>
          You own the data you bring to Collabo, including your customers' information. You are responsible for having
          the right to use it and for meeting the privacy laws that apply to you. How we handle it is set out in our{" "}
          <Link to="/privacy">privacy policy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Plans and payment">
        <p>
          Paid plans are billed in advance for each period through our payment provider. Fees are non-refundable unless
          the law requires otherwise. Messaging charges set by Meta are separate.
        </p>
      </LegalSection>

      <LegalSection title="Availability">
        <p>
          We work to keep Collabo running but provide it "as is", without a promise that it will always be available or
          free of errors. Connected platforms can change or limit their services, which may affect Collabo's features.
        </p>
      </LegalSection>

      <LegalSection title="Liability">
        <p>
          To the extent the law allows, Collabo is not liable for indirect or consequential loss, and our total liability
          is limited to the fees you paid us in the 12 months before the claim.
        </p>
      </LegalSection>

      <LegalSection title="Ending your use">
        <p>
          You can stop using Collabo at any time and ask us to delete your workspace's data. We may end or suspend access
          if these terms are broken.
        </p>
      </LegalSection>

      <LegalSection title="Changes and law">
        <p>
          We will post changes to these terms on this page. These terms are governed by the laws of India, and the courts
          of India have jurisdiction.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Email <SupportEmail />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
