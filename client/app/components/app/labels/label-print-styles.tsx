/**
 * The one stylesheet the print path owns. Everything geometric lives in inline
 * millimetre styles instead; this block carries only the rules a stylesheet is
 * the only place to express.
 *
 * Note for editors: the CSS below sits inside a template literal, so its
 * comments must not contain backticks.
 */
import { buildPageCss, type ResolvedProfile } from "~/lib/label-stock";

export function LabelPrintStyles({ profile }: { profile: ResolvedProfile }) {
  return (
    <style>{`
      /* The printable sheet is not part of the screen layout at all - the rail
         renders its own scaled copy of one page.

         This MUST stay scoped to @media screen rather than being an
         unconditional display:none with a print override. The print whitelist
         below re-shows the sheet with visibility, and visibility cannot
         resurrect a display:none box: a leaked hide rule prints a blank page.
         Same reason it is not written as Tailwind's "hidden print:block", whose
         win depends on emit order and whose display is not !important. */
      @media screen {
        .label-sheet { display: none; }
      }

      @media print {
        ${buildPageCss(profile)}
        body { background: white !important; }

        /* Whitelist, not blacklist.
           Hiding only .no-print assumes every stray node carries the tag, so
           anything this app does not create still prints - portals, and nodes
           injected by browser extensions, which is where the graphics landing
           on top of the barcodes come from. This route's markup has never
           contained an image element in any commit, and the label API returns
           no image field, so there is no element here to remove.

           visibility (not display) for the hide step: it is overridable on
           descendants, so the sheet re-shows even though its ancestors stay
           hidden - display:none would take the sheet with everything else and
           no descendant rule could bring it back. It also leaves the labels'
           boxes and page breaks untouched, which roll mode depends on for
           exactly one die-cut row per page. */
        body * { visibility: hidden !important; }
        .label-sheet, .label-sheet * { visibility: visible !important; }

        /* The screen UI must occupy NO space. visibility alone would leave the
           whole editor's box in the flow and emit a blank leading page. This is
           why the rail preview carries .no-print too, even though it is not
           inside .label-sheet. */
        .no-print { display: none !important; }

        .label-page { box-shadow: none !important; margin: 0 !important; }
      }

      .label-cell { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    `}</style>
  );
}
