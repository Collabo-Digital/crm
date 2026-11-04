import { Link } from "react-router";

import { LEGAL_ENTITY, LegalPage, LegalSection, SupportEmail } from "~/components/app/legal-page";

export function meta() {
  return [{ title: "Privacy policy · Collabo" }];
}

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="4 November 2026">
      <p>
        Collabo (app.collabo.store) is a CRM for online and in-store sellers, run by {LEGAL_ENTITY}, India ("Collabo",
        "we", "us"). This policy explains what information Collabo collects, how it is used and shared, and how to have it
        deleted.
      </p>

      <LegalSection title="Who this covers">
        <p>
          <strong>Merchants</strong> are the businesses and people who sign up for Collabo and connect their store or
          messaging accounts. <strong>Their customers</strong> are the people who buy from, message or comment to a
          merchant. For customer information a merchant keeps in Collabo, the merchant decides how it is used and Collabo
          processes it on the merchant's behalf.
        </p>
      </LegalSection>

      <LegalSection title="Information we collect">
        <ul>
          <li>Account details: name, email address, phone number and password (stored only as a hash).</li>
          <li>Business details the merchant enters: business name, address, tax registration (such as GSTIN) and invoice settings.</li>
          <li>Store data from a connected Shopify store: products, inventory, orders and customers.</li>
          <li>
            Instagram, when a merchant connects a professional account through Instagram Login: the account's id,
            username, name, profile picture and account type; an access token; direct messages sent to and from the
            account; and comments on the account's posts, with the commenter's username and id.
          </li>
          <li>
            WhatsApp, when a merchant connects a WhatsApp Business account: the business account and phone number ids,
            the display number and name, message templates, and messages exchanged with customers, including their phone
            numbers and profile names.
          </li>
          <li>Billing: subscription and payment status from our payment provider. We do not store card numbers.</li>
          <li>Technical data: IP address, browser type and pages used, kept for security and to keep the service working.</li>
        </ul>
      </LegalSection>

      <LegalSection title="How we use it">
        <ul>
          <li>To run the features a merchant uses: the shared inbox, replies, automations (such as answering a comment with a private message), broadcasts, orders, invoices and inventory.</li>
          <li>To send the messages a merchant sends or schedules, only through the merchant's own connected accounts.</li>
          <li>To provide support, keep accounts secure, prevent abuse and meet legal and tax obligations.</li>
        </ul>
        <p>
          We do not sell personal information, use it for advertising, or use data from Instagram or WhatsApp for any
          purpose other than providing Collabo to the merchant who connected the account.
        </p>
      </LegalSection>

      <LegalSection title="Who we share it with">
        <ul>
          <li>Meta (Instagram and WhatsApp), Shopify and other services a merchant connects, to carry out what the merchant asks.</li>
          <li>Service providers that host or deliver Collabo for us, such as cloud hosting, database, email delivery and payment processing, under contracts that limit them to that work.</li>
          <li>Authorities, when the law requires it.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Security">
        <p>
          Data is sent over HTTPS. Access tokens for connected accounts are encrypted before they are stored. Access inside
          a workspace follows the roles and permissions its owner sets.
        </p>
      </LegalSection>

      <LegalSection title="How long we keep it">
        <p>
          We keep a workspace's data while its account is open. Disconnecting Instagram or WhatsApp, or removing Collabo
          from the account in Instagram's settings, deletes the stored access token straight away. Conversation history
          already in a workspace stays with that workspace until the merchant asks us to delete it.
        </p>
      </LegalSection>

      <LegalSection title="Deleting your data">
        <p>
          See <Link to="/data-deletion">how to delete your data</Link>. You can also email <SupportEmail /> to see, correct
          or delete the information we hold about you. We complete requests within 30 days.
        </p>
      </LegalSection>

      <LegalSection title="Children">
        <p>Collabo is a business tool and is not meant for anyone under 18.</p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>We will post any change to this policy on this page and update the date above.</p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          {LEGAL_ENTITY}. Email <SupportEmail />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
