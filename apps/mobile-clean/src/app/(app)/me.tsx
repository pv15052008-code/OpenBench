/**
 * Your profile, your training certificates, and (on phones) links to the
 * sections that don't fit in the bottom bar.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { PhotoPicker, SignedImage } from "@/components/domain";
import { Badge, Body, Button, Chip, Col, Columns, ErrorNote, Field, H3, Page, PageHeader, Panel, Section, Small, useToast, useWide } from "@/components/ui";
import { rpc } from "@/lib/api";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, useAuth } from "@/lib/auth";
import { day } from "@/lib/format";
import { roleLabel } from "@/lib/status";
import { supabase } from "@/lib/supabase";
import { space, usePalette } from "@/lib/theme";
import { upload, type Picked } from "@/lib/upload";

export default function Me() {
  const { profile, refreshProfile, signOut, isStaff, isManager, isAdmin } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const wide = useWide();
  const p = usePalette();

  const depts = useQuery({ queryKey: ["departments"], queryFn: () => rpc<{ id: string; code: string; name: string }[]>("list_departments") });
  const tags = useQuery({ queryKey: ["training-tags"], queryFn: () => rpc<{ tag: string; label: string; department: string }[]>("list_training_tags") });
  const quals = useQuery({
    queryKey: ["my-quals"],
    enabled: !!profile,
    queryFn: async () => {
      const { data, error } = await supabase.from("user_qualifications").select("*").eq("user_id", profile!.id).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data as any[];
    },
  });

  const [name, setName] = useState("");
  const [dept, setDept] = useState<string | null>(null);
  const [year, setYear] = useState("");
  const [roll, setRoll] = useState("");
  useEffect(() => {
    if (profile) { setName(profile.full_name); setDept(profile.department_id); setYear(profile.year_of_study ? String(profile.year_of_study) : ""); setRoll(profile.roll_number ?? ""); }
  }, [profile]);

  const yearOk = !year || /^[1-6]$/.test(year);
  const rollOk = !roll || /^[A-Za-z0-9/-]{3,20}$/.test(roll);
  const nameOk = name.trim().length >= 2 && name.trim().length <= 80;
  const changed = profile && (name.trim() !== profile.full_name || dept !== profile.department_id || (year ? Number(year) : null) !== profile.year_of_study || (roll || null) !== profile.roll_number);
  const resetsVerification = profile?.verification_status === "verified" && !!changed;

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("profiles").update({
        full_name: name.trim(), department_id: dept, year_of_study: year ? Number(year) : null, roll_number: roll.trim() || null,
      }).eq("id", profile!.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => { await refreshProfile(); toast("Profile saved"); qc.invalidateQueries(); },
  });

  const [tag, setTag] = useState<string | null>(null);
  const [cert, setCert] = useState<Picked[]>([]);
  const [certErr, setCertErr] = useState<unknown>(null);
  const [certBusy, setCertBusy] = useState(false);
  const submitCert = async () => {
    setCertBusy(true); setCertErr(null);
    try {
      const path = await upload("eligibility-docs", profile!.id, cert[0]);
      const existing = (quals.data ?? []).find((q) => q.training_tag === tag);
      const { error } = existing
        ? await supabase.from("user_qualifications").update({ evidence_path: path }).eq("id", existing.id)
        : await supabase.from("user_qualifications").insert({ user_id: profile!.id, training_tag: tag, evidence_path: path });
      if (error) throw new Error(error.message);
      setCert([]); setTag(null);
      toast("Certificate sent for verification");
      qc.invalidateQueries();
    } catch (e) { setCertErr(e); } finally { setCertBusy(false); }
  };

  const switchTo = async (email: string) => {
    await supabase.auth.signOut();
    const { error } = await supabase.auth.signInWithPassword({ email, password: DEMO_PASSWORD });
    if (error) router.replace("/sign-in"); else router.replace("/");
  };

  if (!profile) return <Page><PageHeader title="Me" /></Page>;
  const isDemo = profile.email.endsWith("@demo.openbench.in");

  return (
    <Page>
      <PageHeader title={profile.full_name} intro={`${roleLabel(profile.role)}${profile.department ? `, ${profile.department.name}` : ""}. ${profile.email}`} />
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        <Badge label={profile.verification_status === "verified" ? "Verified account" : profile.verification_status === "pending" ? "Waiting for verification" : "Verification rejected"}
          tone={profile.verification_status === "verified" ? "go" : profile.verification_status === "pending" ? "caution" : "stop"} />
        <Badge label={`${profile.strikes} strike${profile.strikes === 1 ? "" : "s"}`} tone={profile.strikes ? "stop" : "neutral"} />
        {profile.suspended_until && new Date(profile.suspended_until) > new Date() ? <Badge label={`Booking suspended until ${day(profile.suspended_until)}`} tone="stop" /> : null}
      </View>

      {!wide ? (
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          <Button small kind="secondary" icon="alert-triangle" label="Incidents" onPress={() => router.push("/incidents")} />
          {isStaff ? <Button small kind="secondary" icon="package" label="My listings" onPress={() => router.push("/manage")} /> : null}
          {isStaff ? <Button small kind="secondary" icon="shield" label={isAdmin ? "Admin" : "Verify"} onPress={() => router.push("/verify")} /> : null}
          {isManager ? <Button small kind="secondary" icon="book-open" label="Audit log" onPress={() => router.push("/audit")} /> : null}
        </View>
      ) : null}

      <Columns>
        <Col>
          <Section title="Your details" hint="An admin checks these against college records before you can book.">
            <Panel>
              <Field label="Full name" value={name} onChangeText={setName} maxLength={80} error={nameOk ? null : "2 to 80 characters"} />
              <View style={{ gap: space(1) }}>
                <Small>Department</Small>
                <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                  {(depts.data ?? []).map((d) => <Chip key={d.id} label={d.code} selected={dept === d.id} onPress={() => setDept(d.id)} />)}
                </View>
              </View>
              <Field label="Year of study" value={year} onChangeText={setYear} keyboardType="number-pad" maxLength={1} error={yearOk ? null : "1 to 6"} hint="Leave empty for staff" />
              <Field label="Roll or staff number" value={roll} onChangeText={setRoll} autoCapitalize="characters" maxLength={20} error={rollOk ? null : "Letters, digits, / and - only"} />
              {resetsVerification ? <Small style={{ color: p.caution }}>Changing your name, department, year or roll number sends your account back to an admin for verification.</Small> : null}
              <ErrorNote error={save.error} />
              <Button label="Save details" disabled={!changed || !yearOk || !rollOk || !nameOk} loading={save.isPending} onPress={() => save.mutate()} />
            </Panel>
          </Section>
        </Col>
        <Col>
          <Section title="Training certificates" hint="Some resources need proof of a safety induction. The lab owner or an admin verifies it.">
            {(quals.data ?? []).length === 0 ? <Small>None yet.</Small> : (
              <View style={{ gap: space(2) }}>
                {(quals.data ?? []).map((q) => (
                  <Panel key={q.id} style={{ flexDirection: "row", gap: space(3), alignItems: "center" }}>
                    {q.evidence_path ? <SignedImage bucket="eligibility-docs" path={q.evidence_path} size={56} /> : null}
                    <View style={{ flex: 1, gap: 2 }}>
                      <H3>{(tags.data ?? []).find((t) => t.tag === q.training_tag)?.label ?? q.training_tag.replace(/_/g, " ")}</H3>
                      {q.decision_reason ? <Small>{q.decision_reason}</Small> : null}
                      {q.expires_at ? <Small>Valid until {day(q.expires_at)}</Small> : null}
                    </View>
                    <Badge label={q.status} tone={q.status === "verified" ? "go" : q.status === "pending" ? "caution" : "stop"} />
                  </Panel>
                ))}
              </View>
            )}
            <Panel>
              <H3>Upload a certificate</H3>
              <Small>Which training is it for?</Small>
              <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                {(tags.data ?? []).map((t) => <Chip key={t.tag} label={`${t.label} (${t.department})`} selected={tag === t.tag} onPress={() => setTag(t.tag)} />)}
              </View>
              <PhotoPicker photos={cert} onChange={setCert} max={1} onError={setCertErr} />
              <ErrorNote error={certErr} />
              <Button label="Send for verification" icon="upload" disabled={!tag || cert.length === 0} loading={certBusy} onPress={submitCert} />
            </Panel>
          </Section>
        </Col>
      </Columns>

      {isDemo ? (
        <Section title="Switch demo account" hint="For judging: jump between roles without typing passwords.">
          <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
            {DEMO_ACCOUNTS.filter((a) => a.email !== profile.email).map((a) => <Chip key={a.email} label={`${a.name} (${a.role.split(",")[0]})`} onPress={() => switchTo(a.email)} />)}
          </View>
        </Section>
      ) : null}

      <Body style={{ color: p.ink3, fontSize: 14 }}>We store your name, college email, department, year and roll number, plus the certificates and condition photos you upload. Photos and certificates are private: only the people on a booking, or those verifying you, can open them.</Body>
      <Button kind="secondary" icon="log-out" label="Sign out" onPress={async () => { await signOut(); router.replace("/sign-in"); }} style={{ alignSelf: "flex-start" }} />
    </Page>
  );
}
