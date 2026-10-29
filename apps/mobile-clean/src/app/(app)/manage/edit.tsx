/**
 * Create or edit a listing: what it is, where, who may use it, when it's open,
 * fair-use caps, and the checklist people fill in at check-in and return.
 * Everything is saved in one call so a listing is never half-written.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { PhotoPicker } from "@/components/domain";
import { Button, Chip, Col, Columns, ErrorNote, Field, H3, Loading, Page, PageHeader, Panel, Section, Small, Toggle, useToast } from "@/components/ui";
import { rpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { space, usePalette } from "@/lib/theme";
import { publicUrl, upload, type Picked } from "@/lib/upload";

type Req = { type: "training" | "min_year" | "department" | "faculty_sponsor"; value: string; label: string };
type Hours = { on: boolean; opens: string; closes: string };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SLOTS = [15, 30, 60, 120, 180, 240, 480];
const timeOk = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export default function EditResource() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const p = usePalette();
  const { profile, isAdmin } = useAuth();
  const existing = useQuery({ queryKey: ["resource", id], queryFn: () => rpc<any>("get_resource", { p_id: id }), enabled: !!id });
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => rpc<{ id: string; code: string; name: string }[]>("list_departments") });
  const trainings = useQuery({ queryKey: ["training-tags"], queryFn: () => rpc<{ tag: string; label: string; department: string }[]>("list_training_tags") });

  const [f, setF] = useState({
    name: "", kind: "equipment" as "equipment" | "space", category: "", description: "", location: "", quantity: "1",
    slot_minutes: 60, max_hours: "4", lead_time_hours: "2", max_advance_days: "21", deposit_note: "", usage_rules: "",
    status: "active", requires_supervision: false, department_id: null as string | null,
  });
  const [reqs, setReqs] = useState<Req[]>([]);
  const [checklist, setChecklist] = useState<string[]>(["Overall condition as expected"]);
  const [hours, setHours] = useState<Hours[]>(DAYS.map(() => ({ on: false, opens: "09:00", closes: "17:00" })));
  const [alwaysOpen, setAlwaysOpen] = useState(true);
  const [policy, setPolicy] = useState({ max_bookings_per_week: "3", max_hours_per_week: "8", cooldown_hours: "0" });
  // Only send the fair-use policy when the owner changed it, so a department-wide policy isn't
  // frozen into a copy, and settings this form doesn't show (strike limit, first-timer priority) are kept
  const [policyTouched, setPolicyTouched] = useState(!id);
  const [policyExtra, setPolicyExtra] = useState({ max_open_strikes: 3, first_timer_priority: true });
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [newPhoto, setNewPhoto] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(!id);

  useEffect(() => {
    const r = existing.data;
    if (!r || loaded) return;
    setF({
      name: r.name, kind: r.kind, category: r.category, description: r.description, location: r.location, quantity: String(r.quantity),
      slot_minutes: r.slot_minutes, max_hours: String(r.max_minutes_per_booking / 60), lead_time_hours: String(r.lead_time_hours),
      max_advance_days: String(r.max_advance_days), deposit_note: r.deposit_note, usage_rules: r.usage_rules, status: r.status,
      requires_supervision: r.requires_supervision, department_id: r.department_id,
    });
    setReqs((r.requirements as any[]).map((x) => ({ type: x.type, value: x.value, label: x.label })));
    setChecklist((r.checklist_template as any[]).map((c) => c.label));
    const weekly = (r.availability as any[]).filter((a) => a.weekday !== null);
    setAlwaysOpen(weekly.length === 0);
    setHours(DAYS.map((_, i) => {
      const a = weekly.find((w) => w.weekday === i);
      return a ? { on: true, opens: a.opens_at.slice(0, 5), closes: a.closes_at.slice(0, 5) } : { on: false, opens: "09:00", closes: "17:00" };
    }));
    const pol = (r.policy ?? {}) as any;
    setPolicy({ max_bookings_per_week: String(pol.max_bookings_per_week ?? 3), max_hours_per_week: String((pol.max_minutes_per_week ?? 480) / 60), cooldown_hours: String(pol.cooldown_hours ?? 0) });
    setPolicyExtra({ max_open_strikes: pol.max_open_strikes ?? 3, first_timer_priority: pol.first_timer_priority ?? true });
    setPhotoUrls(r.photo_urls ?? []);
    setLoaded(true);
  }, [existing.data, loaded]);

  const set = (k: keyof typeof f, v: any) => setF((prev) => ({ ...prev, [k]: v }));
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const maxMinutes = Math.round(num(f.max_hours) * 60);

  const problems: string[] = [];
  if (f.name.trim().length < 3) problems.push("Name needs at least 3 characters.");
  if (f.category.trim().length < 2) problems.push("Add a category.");
  if (f.location.trim().length < 2) problems.push("Add a location.");
  if (!(num(f.quantity) >= 1 && num(f.quantity) <= 500 && Number.isInteger(num(f.quantity)))) problems.push("Quantity must be 1 to 500.");
  if (!(maxMinutes >= f.slot_minutes && maxMinutes <= 10080 && maxMinutes % f.slot_minutes === 0)) problems.push(`Longest booking must be a multiple of ${f.slot_minutes} minutes, up to 7 days.`);
  if (!(num(f.lead_time_hours) >= 0 && num(f.lead_time_hours) <= 720)) problems.push("Notice must be 0 to 720 hours.");
  if (!(num(f.max_advance_days) >= 1 && num(f.max_advance_days) <= 365)) problems.push("Booking window must be 1 to 365 days.");
  if (!alwaysOpen && !hours.some((h) => h.on)) problems.push("Open on at least one day, or choose open at any time.");
  if (!alwaysOpen && hours.some((h) => h.on && (!timeOk(h.opens) || !timeOk(h.closes) || h.opens >= h.closes))) problems.push("Opening hours need HH:MM, with opening before closing.");
  if (reqs.some((r) => r.label.trim().length < 2 || !r.value.trim())) problems.push("Every requirement needs a description.");
  if (reqs.some((r) => r.type === "min_year" && !/^[1-6]$/.test(r.value))) problems.push("Minimum year must be 1 to 6.");
  if (checklist.some((c) => c.trim().length < 2)) problems.push("Checklist items can't be empty.");
  if (!(num(policy.max_bookings_per_week) >= 1 && num(policy.max_bookings_per_week) <= 50)) problems.push("Bookings per week must be 1 to 50.");
  if (!(num(policy.max_hours_per_week) * 60 >= 15 && num(policy.max_hours_per_week) <= 168)) problems.push("Hours per week must be 0.25 to 168.");
  if (!(num(policy.cooldown_hours) >= 0 && num(policy.cooldown_hours) <= 168)) problems.push("Gap between uses must be 0 to 168 hours.");

  const save = async () => {
    setBusy(true); setError(null);
    try {
      let urls = photoUrls;
      if (newPhoto[0]) {
        // Everyone uploads to their own folder; the database accepts photos from the owner's or the editor's folder
        const path = await upload("resource-photos", profile!.id, newPhoto[0]);
        urls = [publicUrl("resource-photos", path), ...photoUrls].slice(0, 4);
      }
      const usedKeys = new Set<string>();
      const payload = {
        id: id ?? null, name: f.name.trim(), kind: f.kind, category: f.category.trim(), description: f.description.trim(), location: f.location.trim(),
        quantity: num(f.quantity), slot_minutes: f.slot_minutes, max_minutes_per_booking: maxMinutes, lead_time_hours: num(f.lead_time_hours),
        max_advance_days: num(f.max_advance_days), deposit_note: f.deposit_note.trim(), usage_rules: f.usage_rules.trim(), status: f.status,
        requires_supervision: f.requires_supervision, department_id: f.department_id, photo_urls: urls,
        checklist_template: checklist.map((label) => {
          let key = slug(label) || "item"; while (usedKeys.has(key)) key = `${key}_x`.slice(0, 40); usedKeys.add(key);
          return { key, label: label.trim() };
        }),
        requirements: reqs.map((r) => ({ ...r, value: r.type === "training" ? slug(r.value) : r.value.trim(), label: r.label.trim() })),
        availability: alwaysOpen ? [] : hours.flatMap((h, i) => (h.on ? [{ weekday: i, opens_at: h.opens, closes_at: h.closes }] : [])),
      };
      const body: Record<string, unknown> = { ...payload };
      if (policyTouched) {
        body.policy = { max_bookings_per_week: num(policy.max_bookings_per_week), max_minutes_per_week: Math.round(num(policy.max_hours_per_week) * 60),
                        cooldown_hours: num(policy.cooldown_hours), ...policyExtra };
      }
      const newId = await rpc<string>("save_resource", { p: body });
      qc.invalidateQueries();
      toast(id ? "Listing saved" : "Listing created");
      router.replace(`/resources/${newId}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (id && !loaded) return <Page>{existing.error ? <ErrorNote error={existing.error} /> : <Loading />}</Page>;

  return (
    <Page>
      <PageHeader title={id ? `Edit ${f.name}` : "New listing"} back={() => router.back()} intro="Students see all of this before they request. Changes apply to new requests." />
      <Columns>
        <Col>
          <Section title="What it is">
            <Panel>
              <View style={{ flexDirection: "row", gap: space(2) }}>
                <Chip label="Equipment" selected={f.kind === "equipment"} onPress={() => set("kind", "equipment")} />
                <Chip label="Space or room" selected={f.kind === "space"} onPress={() => set("kind", "space")} />
              </View>
              <Field label="Name" value={f.name} onChangeText={(t) => set("name", t)} maxLength={120} placeholder="Prusa MK4 3D Printer" />
              <Field label="Category" value={f.category} onChangeText={(t) => set("category", t)} maxLength={40} placeholder="3D printer" />
              <Field label="Description" value={f.description} onChangeText={(t) => set("description", t)} multiline maxLength={4000} />
              <Field label="Location" value={f.location} onChangeText={(t) => set("location", t)} maxLength={160} placeholder="Fabrication Lab, ME Block B-204" />
              <Field label="How many identical units" value={f.quantity} onChangeText={(t) => set("quantity", t)} keyboardType="number-pad" hint="More than 1 makes it a pool, like 10 Arduino kits." />
              {isAdmin ? (
                <View style={{ gap: space(1) }}>
                  <Small>Department</Small>
                  <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                    {(depts.data ?? []).map((d) => <Chip key={d.id} label={d.code} selected={f.department_id === d.id} onPress={() => set("department_id", d.id)} />)}
                  </View>
                </View>
              ) : <Small>Listed under your department{profile?.department ? `, ${profile.department.name}` : ""}.</Small>}
              <Small>Photo (optional)</Small>
              <PhotoPicker photos={newPhoto} onChange={setNewPhoto} max={1} onError={setError} required={false} />
            </Panel>
          </Section>

          <Section title="Rules">
            <Panel>
              <Field label="Rules of use" value={f.usage_rules} onChangeText={(t) => set("usage_rules", t)} multiline maxLength={4000} />
              <Field label="Deposit or charges (leave empty if none)" value={f.deposit_note} onChangeText={(t) => set("deposit_note", t)} maxLength={400} hint="If set, students must accept it before requesting." />
              <Toggle label="Supervised use only" value={f.requires_supervision} onChange={(v) => set("requires_supervision", v)} />
              <Small>Status</Small>
              <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                {[["active", "Open for booking"], ["maintenance", "Under maintenance"], ["draft", "Draft, hidden"], ["retired", "Retired"]].map(([v, l]) =>
                  <Chip key={v} label={l} selected={f.status === v} onPress={() => set("status", v)} />)}
              </View>
            </Panel>
          </Section>

          <Section title="Condition checklist" hint="Ticked at check-in and again at return.">
            <Panel>
              {checklist.map((c, i) => (
                <View key={i} style={{ flexDirection: "row", gap: space(2), alignItems: "flex-end" }}>
                  <View style={{ flex: 1 }}><Field label={`Item ${i + 1}`} value={c} onChangeText={(t) => setChecklist((prev) => prev.map((x, j) => (j === i ? t : x)))} maxLength={120} /></View>
                  <Button small kind="ghost" icon="trash-2" label="Remove" onPress={() => setChecklist((prev) => prev.filter((_, j) => j !== i))} />
                </View>
              ))}
              {checklist.length < 20 ? <Button small kind="secondary" icon="plus" label="Add item" onPress={() => setChecklist([...checklist, ""])} style={{ alignSelf: "flex-start" }} /> : null}
            </Panel>
          </Section>
        </Col>

        <Col>
          <Section title="Who can use it" hint="Every requirement must be met. Students see each one before requesting.">
            <Panel>
              {reqs.length === 0 ? <Small>No requirements: any verified account can request.</Small> : null}
              {reqs.map((r, i) => (
                <View key={i} style={{ gap: space(2), paddingBottom: space(2), borderBottomWidth: 1, borderBottomColor: p.rule }}>
                  <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                    {([["training", "Training"], ["min_year", "Minimum year"], ["department", "Department only"], ["faculty_sponsor", "Course or faculty link"]] as const).map(([v, l]) =>
                      <Chip key={v} label={l} selected={r.type === v} onPress={() => setReqs((prev) => prev.map((x, j) => (j === i ? { ...x, type: v, value: v === "faculty_sponsor" ? "course" : "" } : x)))} />)}
                  </View>
                  {r.type === "training" ? (
                    <View style={{ gap: space(2) }}>
                      <Small>Registered trainings (the department that runs each one verifies its certificates)</Small>
                      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                        {(trainings.data ?? []).map((t) => (
                          <Chip key={t.tag} label={`${t.label} (${t.department})`} selected={r.value === t.tag}
                            onPress={() => setReqs((prev) => prev.map((x, j) => (j === i ? { ...x, value: t.tag, label: t.label } : x)))} />
                        ))}
                      </View>
                      <Field label="Or a new training (department managers only)" value={r.value} onChangeText={(t) => setReqs((prev) => prev.map((x, j) => (j === i ? { ...x, value: t, label: x.label || t } : x)))} placeholder="welding_safety" />
                    </View>
                  ) : null}
                  {r.type === "min_year" ? <Field label="Minimum year" value={r.value} onChangeText={(t) => setReqs((prev) => prev.map((x, j) => (j === i ? { ...x, value: t } : x)))} keyboardType="number-pad" maxLength={1} /> : null}
                  {r.type === "department" ? (
                    <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                      {(depts.data ?? []).map((d) => <Chip key={d.id} label={d.code} selected={r.value === d.code} onPress={() => setReqs((prev) => prev.map((x, j) => (j === i ? { ...x, value: d.code } : x)))} />)}
                    </View>
                  ) : null}
                  <Field label="Shown to students as" value={r.label} onChangeText={(t) => setReqs((prev) => prev.map((x, j) => (j === i ? { ...x, label: t } : x)))} maxLength={160} placeholder="3D printing safety induction" />
                  <Button small kind="ghost" icon="trash-2" label="Remove requirement" onPress={() => setReqs((prev) => prev.filter((_, j) => j !== i))} style={{ alignSelf: "flex-start" }} />
                </View>
              ))}
              {reqs.length < 10 ? <Button small kind="secondary" icon="plus" label="Add requirement" onPress={() => setReqs([...reqs, { type: "training", value: "", label: "" }])} style={{ alignSelf: "flex-start" }} /> : null}
            </Panel>
          </Section>

          <Section title="Timing">
            <Panel>
              <Small>Booking steps</Small>
              <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                {SLOTS.map((m) => <Chip key={m} label={m < 60 ? `${m} min` : `${m / 60} h`} selected={f.slot_minutes === m} onPress={() => set("slot_minutes", m)} />)}
              </View>
              <Field label="Longest booking, in hours" value={f.max_hours} onChangeText={(t) => set("max_hours", t)} keyboardType="decimal-pad" />
              <Field label="Notice needed, in hours" value={f.lead_time_hours} onChangeText={(t) => set("lead_time_hours", t)} keyboardType="number-pad" hint="0 lets people start right away." />
              <Field label="How far ahead people can book, in days" value={f.max_advance_days} onChangeText={(t) => set("max_advance_days", t)} keyboardType="number-pad" />
              <Toggle label="Open at any time" value={alwaysOpen} onChange={setAlwaysOpen} />
              {!alwaysOpen ? hours.map((h, i) => (
                <View key={i} style={{ flexDirection: "row", gap: space(2), alignItems: "flex-end" }}>
                  <View style={{ width: 70, paddingBottom: 8 }}><Chip label={DAYS[i]} selected={h.on} onPress={() => setHours((prev) => prev.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} /></View>
                  {h.on ? (
                    <>
                      <View style={{ flex: 1 }}><Field label="Opens" value={h.opens} onChangeText={(t) => setHours((prev) => prev.map((x, j) => (j === i ? { ...x, opens: t } : x)))} maxLength={5} /></View>
                      <View style={{ flex: 1 }}><Field label="Closes" value={h.closes} onChangeText={(t) => setHours((prev) => prev.map((x, j) => (j === i ? { ...x, closes: t } : x)))} maxLength={5} /></View>
                    </>
                  ) : <Small style={{ paddingBottom: 12 }}>Closed</Small>}
                </View>
              )) : null}
            </Panel>
          </Section>

          <Section title="Fair use" hint="Per person, per week. When requests clash, first-time users go first.">
            <Panel>
              <Field label="Bookings per week" value={policy.max_bookings_per_week} onChangeText={(t) => { setPolicyTouched(true); setPolicy((prev) => ({ ...prev, max_bookings_per_week: t })); }} keyboardType="number-pad" />
              <Field label="Hours per week" value={policy.max_hours_per_week} onChangeText={(t) => { setPolicyTouched(true); setPolicy((prev) => ({ ...prev, max_hours_per_week: t })); }} keyboardType="decimal-pad" />
              <Field label="Gap between one person's uses, in hours" value={policy.cooldown_hours} onChangeText={(t) => { setPolicyTouched(true); setPolicy((prev) => ({ ...prev, cooldown_hours: t })); }} keyboardType="number-pad" />
            </Panel>
          </Section>
        </Col>
      </Columns>

      {problems.length ? (
        <Panel tone="caution">
          <H3>Before you save</H3>
          {problems.map((x) => <Small key={x}>{x}</Small>)}
        </Panel>
      ) : null}
      <ErrorNote error={error} />
      <Button label={id ? "Save changes" : "Create listing"} icon="save" disabled={problems.length > 0} loading={busy} onPress={save} style={{ alignSelf: "flex-start" }} />
    </Page>
  );
}
