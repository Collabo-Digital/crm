import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowLeft, ExternalLink, FileSpreadsheet, Loader2, Plus, Trash2, Unlink } from "lucide-react";
import { toast } from "sonner";

import { SectionCard } from "~/components/app/section-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "~/components/ui/page-header";
import { Skeleton } from "~/components/ui/skeleton";
import { useCurrentRole } from "~/hooks/use-current-role";
import { useGoogleIntegration, useGoogleMutation } from "~/hooks/use-google";
import { formatDateTime } from "~/lib/format-date";
import { handleMutationError } from "~/lib/handle-mutation-error";
import { pickSpreadsheet, pickerAvailable } from "~/lib/google-picker";
import { canEditAutomations } from "~/lib/permissions";
import { googleService } from "~/services/google.service";

export function meta() {
  return [{ title: "Google Sheets | Collabo CRM" }];
}

/** Campaigns → Automations → Google Sheets: the Google account and the sheets automations use. */
export default function GoogleSheetsPage() {
  const { data, isLoading, isError } = useGoogleIntegration();
  const act = useGoogleMutation();
  // Its own instance, so finishing a sign-in does not show the sheet buttons busy.
  const finish = useGoogleMutation();
  const { role, permissions } = useCurrentRole();
  const canConnect = role === "OWNER" || role === "ADMIN";
  const canEdit = canEditAutomations(role, permissions) && role !== "INFLUENCER";
  const [params, setParams] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [title, setTitle] = useState("");
  const [headers, setHeaders] = useState("Name, Phone, Email");

  // Google sends the browser back here; the sign-in is finished signed in, by whoever started it.
  const finished = useRef<string | null>(null);
  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    if ((!code && !error) || finished.current === (state ?? error)) return;
    finished.current = state ?? error;
    setParams((p) => {
      ["code", "state", "scope", "error", "authuser", "prompt", "hd"].forEach((k) => p.delete(k));
      return p;
    }, { replace: true });
    if (code && state) finish.mutate({ kind: "complete", code, state });
    else toast.error(error === "access_denied" ? "Google was not connected: access was not allowed." : "Google could not be connected. Try again.");
  }, [params, setParams, finish]);

  const connect = async () => {
    setConnecting(true);
    try {
      window.location.href = (await googleService.connectUrl()).url;
    } catch (err) {
      setConnecting(false);
      handleMutationError(err, "Google could not be connected.");
    }
  };

  const pick = async () => {
    setPicking(true);
    try {
      const { accessToken } = await googleService.pickerToken();
      const chosen = await pickSpreadsheet(accessToken);
      if (chosen) act.mutate({ kind: "picked", spreadsheetId: chosen.id });
    } catch (err) {
      handleMutationError(err, "Google’s picker could not open.");
    } finally {
      setPicking(false);
    }
  };

  const columns = headers.split(",").map((h) => h.trim()).filter(Boolean);

  return (
    <div className="space-y-6">
      <Link to="/campaigns/automations" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" />
        Automations
      </Link>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Google Sheets</PageHeaderTitle>
          <PageHeaderDescription>Add a row to a sheet from any automation, or start one when a row is added: a form response, a lead your team types in.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      {isError ? (
        <p className="text-caption text-danger">Google Sheets could not be loaded.</p>
      ) : isLoading || !data ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : !data.configured ? (
        <SectionCard title="Not set up yet" icon={<FileSpreadsheet className="size-4 text-muted-foreground" />}>
          <p className="px-5 py-4 text-caption text-muted-foreground">
            Google Sheets needs Collabo’s Google OAuth client (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server). Once it is set, owners and admins connect their Google account here.
          </p>
        </SectionCard>
      ) : (
        <>
          <SectionCard title="Google account" icon={<FileSpreadsheet className="size-4 text-muted-foreground" />} description="Collabo only reaches the sheets it creates and the ones you choose here, never the rest of your Drive.">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              {data.connected ? (
                <>
                  <div className="min-w-0">
                    <p className="text-body font-medium">{data.email ?? "Connected"}</p>
                    {data.connectedAt && <p className="text-micro text-muted-foreground">Connected {formatDateTime(data.connectedAt)}</p>}
                  </div>
                  {canConnect && (
                    <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ kind: "disconnect" })}>
                      <Unlink />
                      Disconnect
                    </Button>
                  )}
                </>
              ) : canConnect ? (
                <Button size="sm" onClick={() => void connect()} disabled={connecting || finish.isPending}>
                  {(connecting || finish.isPending) && <Loader2 className="animate-spin" />}
                  Connect Google
                </Button>
              ) : (
                <p className="text-caption text-muted-foreground">Not connected. An owner or admin can connect a Google account here.</p>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="Sheets"
            description={data.sheets.length ? "Automations add rows to these, or start when a row is added. Removing one here leaves it in Google Drive." : undefined}
            action={
              data.connected && canEdit && pickerAvailable ? (
                <Button size="sm" variant="outline" disabled={picking || act.isPending} onClick={() => void pick()}>
                  {picking && <Loader2 className="animate-spin" />}
                  Choose an existing sheet
                </Button>
              ) : undefined
            }
          >
            {data.sheets.length === 0 ? (
              <p className="px-5 py-4 text-caption text-muted-foreground">No sheets yet.</p>
            ) : (
              <ul className="divide-y">
                {data.sheets.map((s) => (
                  <li key={s.id} className="flex items-start justify-between gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-body font-medium underline-offset-2 hover:underline">
                        {s.title}
                        <ExternalLink className="size-3.5 text-muted-foreground" />
                      </a>
                      <p className="text-micro text-muted-foreground">
                        {s.origin === "created" ? "Made by Collabo" : "Chosen from your Drive"} · tab “{s.tab}”
                        {s.watched ? ` · new rows are read${s.checkedAt ? `, last at ${formatDateTime(s.checkedAt)}` : ""}` : ""}
                      </p>
                      {s.lastError && <p className="mt-0.5 text-micro text-danger">{s.lastError}</p>}
                      {s.skippedRow && <p className="mt-0.5 text-micro text-warning-strong">Skipped: {s.skippedRow}</p>}
                    </div>
                    {canEdit && (
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${s.title} from Collabo`} disabled={act.isPending} onClick={() => act.mutate({ kind: "remove", id: s.id })}>
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.connected && canEdit && (
              <form
                className="space-y-3 border-t px-5 py-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  act.mutate({ kind: "create", title: title.trim(), headers: columns }, { onSuccess: () => setTitle("") });
                }}
              >
                <p className="text-body font-medium">Create a sheet</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="sheet-title">Name</Label>
                    <Input id="sheet-title" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="WhatsApp leads" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sheet-columns">Columns</Label>
                    <Input id="sheet-columns" value={headers} maxLength={600} onChange={(e) => setHeaders(e.target.value)} />
                  </div>
                </div>
                <p className="text-micro text-muted-foreground">Separate the columns with commas. The sheet is made in your Google Drive with these as its first row.</p>
                <Button type="submit" size="sm" disabled={act.isPending || !title.trim() || !columns.length}>
                  {act.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                  Create in Google Drive
                </Button>
              </form>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
