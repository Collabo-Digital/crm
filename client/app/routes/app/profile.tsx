import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Edit2, Loader2, Lock, Mail, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "~/stores/auth.store";
import { useSectionAccess } from "~/hooks/use-section-access";
import { userService } from "~/services/user.service";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { PageHeader, PageHeaderContent, PageHeaderTitle, PageHeaderDescription } from "~/components/ui/page-header";

export function meta() {
  return [{ title: "Profile | Collabo CRM" }];
}

export default function ProfilePage() {
  const { canAccess } = useSectionAccess();
  const user = useAuthStore((state) => state.user);
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const initials = `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase();
  const update = useMutation({
    mutationFn: (names: { firstName: string; lastName: string }) => userService.updateProfile(names),
    onSuccess: (_result, names) => {
      useAuthStore.setState((state) => ({ user: state.user ? { ...state.user, ...names } : null }));
      setEditing(false);
      toast.success("Profile updated.");
    },
    onError: () => toast.error("Your changes could not be saved. Please try again."),
  });

  function openEditor() {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setEditing(true);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader><PageHeaderContent><PageHeaderTitle>My profile</PageHeaderTitle><PageHeaderDescription>Your personal details and account.</PageHeaderDescription></PageHeaderContent></PageHeader>
      <div className="rounded-3xl bg-card px-5 py-8 text-center md:ring-1 md:ring-border">
        <Avatar className="mx-auto mb-4 size-24 ring-4 ring-brand/40">
          <AvatarImage src={user?.avatarUrl ?? ""} alt={user?.firstName ?? "Profile"} />
          <AvatarFallback className="bg-brand text-3xl font-semibold text-brand-foreground">{initials || <UserRound />}</AvatarFallback>
        </Avatar>
        <h2 className="text-xl font-semibold tracking-tight">{user?.firstName} {user?.lastName}</h2>
        <p className="mt-1 break-all text-sm text-muted-foreground">{user?.email}</p>
      </div>
      <section className="rounded-3xl bg-card p-5 md:p-6 md:ring-1 md:ring-border">
        <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Personal information</h2><Button variant="ghost" onClick={openEditor} className="gap-2 text-brand-strong"><Edit2 className="size-4" />Edit</Button></div>
        <dl className="divide-y divide-border/60">
          <div className="flex items-start gap-4 py-4"><UserRound className="mt-1 size-5 shrink-0 text-muted-foreground" strokeWidth={1.7} /><div><dt className="text-xs text-muted-foreground">Name</dt><dd className="mt-1 text-sm font-medium">{user?.firstName} {user?.lastName}</dd></div></div>
          <div className="flex items-start gap-4 py-4"><Mail className="mt-1 size-5 shrink-0 text-muted-foreground" strokeWidth={1.7} /><div className="min-w-0"><dt className="text-xs text-muted-foreground">Email address</dt><dd className="mt-1 break-all text-sm font-medium">{user?.email}</dd></div></div>
        </dl>
      </section>
      {canAccess("/settings/security") && <Link to="/settings/security" className="flex min-h-20 items-center gap-4 rounded-3xl bg-card p-5 md:ring-1 md:ring-border"><span className="grid size-10 place-items-center rounded-2xl bg-surface-sunken"><Lock className="size-5 text-brand-strong" strokeWidth={1.7} /></span><span><span className="block text-sm font-semibold">Account security</span><span className="mt-1 block text-xs text-muted-foreground">Manage your password</span></span><ChevronRight className="ml-auto size-4 text-muted-foreground" /></Link>}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit profile</DialogTitle><DialogDescription>This is how your name appears to your team.</DialogDescription></DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); if (firstName.trim() && lastName.trim()) update.mutate({ firstName: firstName.trim(), lastName: lastName.trim() }); }} className="space-y-5">
            <div className="space-y-2"><label htmlFor="profile-first-name" className="text-sm font-medium">First name</label><Input id="profile-first-name" autoComplete="given-name" required maxLength={100} value={firstName} onChange={(event) => setFirstName(event.target.value)} /></div>
            <div className="space-y-2"><label htmlFor="profile-last-name" className="text-sm font-medium">Last name</label><Input id="profile-last-name" autoComplete="family-name" required maxLength={100} value={lastName} onChange={(event) => setLastName(event.target.value)} /></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={update.isPending}>Cancel</Button><Button type="submit" variant="accent" disabled={update.isPending || !firstName.trim() || !lastName.trim()}>{update.isPending && <Loader2 className="size-4 animate-spin" />}Save changes</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
