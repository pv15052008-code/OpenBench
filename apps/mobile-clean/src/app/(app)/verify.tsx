/**
 * Verification and administration. Owners verify certificates for their resources;
 * managers verify accounts in their department; admins see everything, change roles
 * and can reset the demo data.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { SignedImage, Stat } from "@/components/domain";
import { Badge, Body, Button, Chip, Empty, ErrorNote, Field, H3, Loading, Page, PageHeader, Panel, ReasonDialog, Section, Small, useToast } from "@/components/ui";
import { engine, engineConfigured, rpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ago, istDate } from "@/lib/format";
import { roleLabel } from "@/lib/status";
import { space, usePalette } from "@/lib/theme";

type Dlg = null | { kind: "profile"; id: string; status: "verified" | "rejected"; name: string }
  | { kind: "qual"; id: string; status: "verified" | "rejected"; name: string }
  | { kind: "role"; id: string; name: string; role: string; dept: string | null }
  | { kind: "strikes"; id: string; name: string };

export default function Verify() {
  const { isAdmin, isManager } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const p = usePalette();
  const [tab, setTab] = useState<"certs" | "accounts" | "people" | "fairness">("certs");
  const [dlg, setDlg] = useState<Dlg>(null);
  const [expires, setExpires] = useState("");
  const [roleDept, setRoleDept] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["verify"], queryFn: () => rpc<{ profiles: any[]; qualifications: any[]; users: any[] }>("verification_queue") });
  const fair = useQuery({ queryKey: ["fairness"], queryFn: () => rpc<any[]>("fairness_report"), enabled: tab === "fairness" });
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => rpc<{ id: string; code: string }[]>("list_departments") });
  const prescreen = useMutation({ mutationFn: (id: string) => engine(`/ai/certificate/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["verify"] }) });
  const reset = useMutation({ mutationFn: () => engine("/admin/reset-demo"), onSuccess: () => { toast("Demo data reset"); qc.invalidateQueries(); } });
  const [confirmReset, setConfirmReset] = useState(false);

  const expiryOk = !expires || (/^\d{4}-\d{2}-\d{2}$/.test(expires) && expires >= istDate(new Date()));
  const d = q.data;

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title={isAdmin ? "Admin" : "Verify"} intro="Check people and certificates before they can use restricted equipment. Every decision is recorded with your reason." />
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        <Chip label={`Certificates (${d?.qualifications.length ?? 0})`} selected={tab === "certs"} onPress={() => setTab("certs")} />
        {isManager ? <Chip label={`New accounts (${d?.profiles.length ?? 0})`} selected={tab === "accounts"} onPress={() => setTab("accounts")} /> : null}
        {isManager ? <Chip label="People" selected={tab === "people"} onPress={() => setTab("people")} /> : null}
        <Chip label="Fair use report" selected={tab === "fairness"} onPress={() => setTab("fairness")} />
      </View>
      <ErrorNote error={q.error ?? prescreen.error} retry={() => q.refetch()} />

      {q.isLoading ? <Loading /> : tab === "certs" ? (
        (d?.qualifications.length ?? 0) === 0 ? <Empty title="No certificates waiting" body="Students upload them from their profile when a resource needs training." /> : (
          d!.qualifications.map((c) => (
            <Panel key={c.id}>
              <View style={{ flexDirection: "row", gap: space(4), flexWrap: "wrap" }}>
                {c.evidence_path ? <SignedImage bucket="eligibility-docs" path={c.evidence_path} size={140} /> : <Small>No file</Small>}
                <View style={{ flex: 1, gap: space(1), minWidth: 220 }}>
                  <H3>{c.user?.full_name}, {c.user?.department ?? "no department"}{c.user?.year_of_study ? ` year ${c.user.year_of_study}` : ""}</H3>
                  <Small>Training: {c.training_tag.replace(/_/g, " ")}. Uploaded {ago(c.created_at)}.</Small>
                  {c.ai_review ? (
                    <View style={{ borderLeftWidth: 2, borderLeftColor: p.brand, paddingLeft: space(3), gap: 2, marginTop: space(1) }}>
                      {c.ai_review.source === "gemini" ? (
                        <>
                          <Small style={{ color: p.ink }}>Name on document: {c.ai_review.name_on_document || "not readable"} {c.ai_review.name_matches ? "(matches profile)" : "(does not match profile)"}</Small>
                          <Small style={{ color: p.ink }}>Training: {c.ai_review.course_or_training || "not readable"} {c.ai_review.tag_matches ? "(matches)" : "(check)"}</Small>
                          {c.ai_review.date_issued ? <Small>Issued {c.ai_review.date_issued}{c.ai_review.valid_until ? `, valid until ${c.ai_review.valid_until}` : ""}</Small> : null}
                          {c.ai_review.notes ? <Small>{c.ai_review.notes}</Small> : null}
                          <Small style={{ color: p.ink3 }}>AI pre-screen. Advisory only: check the document yourself.</Small>
                        </>
                      ) : <Small>{c.ai_review.notes}</Small>}
                    </View>
                  ) : null}
                  <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap", marginTop: space(2) }}>
                    {engineConfigured ? <Button small kind="secondary" icon="eye" label="AI pre-screen" loading={prescreen.isPending && prescreen.variables === c.id} onPress={() => prescreen.mutate(c.id)} /> : null}
                    <Button small icon="check" label="Verify" onPress={() => { setExpires(""); setDlg({ kind: "qual", id: c.id, status: "verified", name: c.user?.full_name }); }} />
                    <Button small kind="danger" icon="x" label="Reject" onPress={() => setDlg({ kind: "qual", id: c.id, status: "rejected", name: c.user?.full_name })} />
                  </View>
                </View>
              </View>
            </Panel>
          ))
        )
      ) : tab === "accounts" ? (
        (d?.profiles.length ?? 0) === 0 ? <Empty title="No accounts waiting" /> : d!.profiles.map((u) => (
          <Panel key={u.id}>
            <H3>{u.full_name}</H3>
            <Small>{u.email}. {u.department ?? "No department"}{u.year_of_study ? `, year ${u.year_of_study}` : ""}. Roll number: {u.roll_number ?? "not given"}. Signed up {ago(u.created_at)}.</Small>
            <View style={{ flexDirection: "row", gap: space(2) }}>
              <Button small icon="check" label="Verify" onPress={() => setDlg({ kind: "profile", id: u.id, status: "verified", name: u.full_name })} />
              <Button small kind="danger" icon="x" label="Reject" onPress={() => setDlg({ kind: "profile", id: u.id, status: "rejected", name: u.full_name })} />
            </View>
          </Panel>
        ))
      ) : tab === "people" ? (
        <View style={{ borderWidth: 1, borderColor: p.rule, borderRadius: 6, backgroundColor: p.surface }}>
          {(d?.users ?? []).map((u, i) => (
            <View key={u.id} style={{ flexDirection: "row", alignItems: "center", gap: space(3), padding: space(3), borderTopWidth: i ? 1 : 0, borderTopColor: p.rule, flexWrap: "wrap" }}>
              <View style={{ flex: 1, minWidth: 200 }}>
                <H3>{u.full_name}</H3>
                <Small>{roleLabel(u.role)}{u.department ? `, ${u.department}` : ""}. {u.email}</Small>
              </View>
              <Badge label={u.verification_status} tone={u.verification_status === "verified" ? "go" : "caution"} />
              {u.strikes ? <Badge label={`${u.strikes} strike${u.strikes > 1 ? "s" : ""}`} tone="stop" /> : null}
              {u.strikes ? <Button small kind="secondary" label="Clear strikes" onPress={() => setDlg({ kind: "strikes", id: u.id, name: u.full_name })} /> : null}
              {isAdmin ? <Button small kind="secondary" label="Change role" onPress={() => { setRoleDept(null); setDlg({ kind: "role", id: u.id, name: u.full_name, role: u.role, dept: null }); }} /> : null}
            </View>
          ))}
        </View>
      ) : (
        <Section title="Who is using what" hint="Last 30 days. A high top-user share means one person is taking most of the slots.">
          {fair.isLoading ? <Loading /> : (fair.data ?? []).map((r) => (
            <Panel key={r.resource.id}>
              <H3>{r.resource.name}</H3>
              <View style={{ flexDirection: "row", gap: space(6), flexWrap: "wrap" }}>
                <Stat label="hours booked" value={r.total_hours} />
                <Stat label="different people" value={r.distinct_users} />
                <Stat label="top user's share" value={`${r.top_share}%`} />
                <Stat label="waitlisted now" value={r.waitlisted} />
              </View>
              {r.top_share >= 60 && r.distinct_users > 0 ? <Small style={{ color: p.caution }}>One person holds most of the bookings. Consider a lower weekly cap.</Small> : null}
              {(r.top_users as any[]).length ? <Small>Top users: {(r.top_users as any[]).map((t) => `${t.user.full_name} (${t.bookings})`).join(", ")}</Small> : null}
            </Panel>
          ))}
        </Section>
      )}

      {isAdmin && engineConfigured ? (
        <Section title="Demo data" hint="Rebuilds the fictional campus: resources, bookings and history. Accounts are kept.">
          <ErrorNote error={reset.error} />
          <Button kind="danger" icon="refresh-cw" label="Reset demo data" loading={reset.isPending} onPress={() => setConfirmReset(true)} style={{ alignSelf: "flex-start" }} />
        </Section>
      ) : null}

      <ReasonDialog visible={dlg?.kind === "qual"} title={dlg?.kind === "qual" ? `${dlg.status === "verified" ? "Verify" : "Reject"} certificate for ${dlg.name}` : ""}
        confirmLabel={dlg?.kind === "qual" && dlg.status === "verified" ? "Verify" : "Reject"} danger={dlg?.kind === "qual" && dlg.status === "rejected"} minLength={3}
        initial={dlg?.kind === "qual" && dlg.status === "verified" ? "Certificate checked against induction records" : ""}
        extra={dlg?.kind === "qual" && dlg.status === "verified" ? <Field label="Valid until (optional, YYYY-MM-DD)" value={expires} onChangeText={setExpires} placeholder="2027-06-30" error={expiryOk ? null : "Use a future date as YYYY-MM-DD"} /> : undefined}
        onCancel={() => setDlg(null)}
        onConfirm={async (reason) => {
          if (dlg?.kind !== "qual") return;
          if (!expiryOk) throw new Error("Fix the expiry date first.");
          await rpc("verify_qualification", { p_id: dlg.id, p_status: dlg.status, p_reason: reason, p_expires: expires || null });
          setDlg(null); toast(dlg.status === "verified" ? "Certificate verified" : "Certificate rejected"); qc.invalidateQueries();
        }} />
      <ReasonDialog visible={dlg?.kind === "profile"} title={dlg?.kind === "profile" ? `${dlg.status === "verified" ? "Verify" : "Reject"} ${dlg.name}` : ""}
        confirmLabel={dlg?.kind === "profile" && dlg.status === "verified" ? "Verify account" : "Reject account"} minLength={3}
        initial={dlg?.kind === "profile" && dlg.status === "verified" ? "Roll number matches college records" : ""}
        onCancel={() => setDlg(null)}
        onConfirm={async (reason) => {
          if (dlg?.kind !== "profile") return;
          await rpc("verify_profile", { p_user: dlg.id, p_status: dlg.status, p_reason: reason });
          setDlg(null); toast("Account updated"); qc.invalidateQueries();
        }} />
      <ReasonDialog visible={dlg?.kind === "strikes"} title={dlg?.kind === "strikes" ? `Clear strikes for ${dlg.name}` : ""} confirmLabel="Clear strikes"
        onCancel={() => setDlg(null)}
        onConfirm={async (reason) => {
          if (dlg?.kind !== "strikes") return;
          await rpc("clear_strikes", { p_user: dlg.id, p_reason: reason });
          setDlg(null); toast("Strikes cleared"); qc.invalidateQueries();
        }} />
      <ReasonDialog visible={dlg?.kind === "role"} title={dlg?.kind === "role" ? `Change role for ${dlg.name}` : ""} confirmLabel="Change role" minLength={3}
        extra={dlg?.kind === "role" ? (
          <View style={{ gap: space(2) }}>
            <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
              {(["user", "owner", "manager", "admin"] as const).map((r) => <Chip key={r} label={roleLabel(r)} selected={dlg.role === r} onPress={() => setDlg({ ...dlg, role: r })} />)}
            </View>
            <Small>Department (needed for managers)</Small>
            <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
              {(depts.data ?? []).map((x) => <Chip key={x.id} label={x.code} selected={roleDept === x.id} onPress={() => setRoleDept(x.id)} />)}
            </View>
          </View>
        ) : undefined}
        onCancel={() => setDlg(null)}
        onConfirm={async (reason) => {
          if (dlg?.kind !== "role") return;
          await rpc("set_user_role", { p_user: dlg.id, p_role: dlg.role, p_department: roleDept, p_reason: reason });
          setDlg(null); toast("Role changed"); qc.invalidateQueries();
        }} />
      <ReasonDialog visible={confirmReset} title="Reset all demo data?" danger confirmLabel="Reset" minLength={0} initial="Reset for judging"
        body="Every resource, booking, incident and log entry is replaced with the original demo set. This cannot be undone."
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => { await reset.mutateAsync(); setConfirmReset(false); }} />
      <Body style={{ color: p.ink3, fontSize: 14 }}>You can't verify yourself or decide on your own requests; another person has to.</Body>
    </Page>
  );
}
