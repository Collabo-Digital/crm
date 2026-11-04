import type { ReactNode } from "react";
import { Link } from "react-router";

import { BrandLogo } from "~/components/app/brand-logo";
import { SUPPORT_EMAIL, supportEmailLink } from "~/lib/support";

/** The company the legal pages speak for. */
export const LEGAL_ENTITY = "Collabo Digital Network Private Limited";

/**
 * Shell for Collabo's public legal pages (privacy, terms, data deletion).
 * Public like the bill and tracking links: outside the app and its sign-in,
 * because Meta's reviewers and anyone deciding whether to sign up read them.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface-sunken px-4 py-10">
      <main className="mx-auto max-w-2xl space-y-6">
        <Link to="/" aria-label="Collabo" className="block w-fit">
          <BrandLogo variant="color" className="h-7" />
        </Link>
        <article className="space-y-6 rounded-2xl bg-card p-6 text-card-foreground shadow-sm ring-1 ring-border sm:p-8">
          <header className="space-y-1">
            <h1 className="font-heading text-subhead">{title}</h1>
            <p className="text-caption text-muted-foreground">Last updated {updated}</p>
          </header>
          <div className="space-y-6 text-body">{children}</div>
        </article>
        <nav className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
          <Link to="/privacy" className="underline-offset-2 hover:underline">Privacy policy</Link>
          <Link to="/terms" className="underline-offset-2 hover:underline">Terms of service</Link>
          <Link to="/data-deletion" className="underline-offset-2 hover:underline">Data deletion</Link>
          <a href={supportEmailLink()} className="underline-offset-2 hover:underline">{SUPPORT_EMAIL}</a>
        </nav>
        <p className="text-center text-caption text-muted-foreground">&copy; {new Date().getFullYear()} {LEGAL_ENTITY}</p>
      </main>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-heading text-body font-semibold">{title}</h2>
      <div className="space-y-2 text-muted-foreground [&_a]:text-brand-strong [&_a]:underline [&_li]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1">{children}</div>
    </section>
  );
}

export function SupportEmail() {
  return <a href={supportEmailLink()}>{SUPPORT_EMAIL}</a>;
}
