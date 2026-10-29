/** Report damage, a delay, something missing or a conflict on a booking. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { PhotoPicker } from "@/components/domain";
import { Body, Button, Chip, ErrorNote, Field, Loading, Page, PageHeader, Section, Small, useToast } from "@/components/ui";
import { rpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { space } from "@/lib/theme";
import { upload, type Picked } from "@/lib/upload";

const TYPES = [["damage", "Damage"], ["missing", "Something missing"], ["delay", "Late or no-show"], ["misuse", "Misuse"], ["conflict", "Scheduling conflict"], ["other", "Other"]] as const;
const SEVERITY = [["low", "Low: cosmetic or minor"], ["medium", "Medium: needs repair or follow-up"], ["high", "High: unsafe or unusable"]] as const;

export default function ReportIncident() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const q = useQuery({ queryKey: ["booking", id], queryFn: () => rpc<any>("get_booking", { p_id: id }), enabled: !!id });
  const [type, setType] = useState<string>("damage");
  const [severity, setSeverity] = useState<string>("medium");
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [photos, setPhotos] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (q.isLoading) return <Page><Loading /></Page>;
  if (!q.data) return <Page><ErrorNote error={q.error ?? new Error("Booking not found")} /></Page>;

  const costNum = cost.trim() ? Number(cost) : null;
  const costBad = costNum !== null && (!Number.isFinite(costNum) || costNum < 0 || costNum > 10000000);
  const ready = description.trim().length >= 10 && !costBad;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const paths: string[] = [];
      for (const ph of photos) paths.push(await upload("incident-photos", `${id}/${profile!.id}`, ph));
      await rpc("report_incident", { p_booking: id, p_type: type, p_severity: severity, p_description: description.trim(), p_photos: paths, p_estimated_cost: costNum });
      qc.invalidateQueries();
      toast("Incident reported. A department manager will review it.", "caution");
      if (router.canGoBack()) router.back(); else router.replace(`/bookings/${id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Page>
      <PageHeader title="Report a problem" back={() => router.back()} intro={q.data.resource.name} />
      <Body style={{ maxWidth: 640 }}>Both people on this booking and the department manager see this report. A manager, not the system, decides the outcome and whether any strike applies.</Body>
      <Section title="What happened">
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          {TYPES.map(([v, l]) => <Chip key={v} label={l} selected={type === v} onPress={() => setType(v)} />)}
        </View>
      </Section>
      <Section title="How serious">
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          {SEVERITY.map(([v, l]) => <Chip key={v} label={l} selected={severity === v} onPress={() => setSeverity(v)} />)}
        </View>
      </Section>
      <Field label="Describe it" value={description} onChangeText={setDescription} multiline maxLength={3000}
        hint={description.trim().length < 10 ? "At least 10 characters. Stick to what you saw." : `${description.length}/3000`} />
      <Field label="Estimated repair cost in ₹ (optional)" value={cost} onChangeText={setCost} keyboardType="decimal-pad" error={costBad ? "Enter a number" : null} />
      <Section title="Photos (optional)">
        <PhotoPicker photos={photos} onChange={setPhotos} onError={setError} required={false} />
      </Section>
      <ErrorNote error={error} />
      <Button label="Send report" icon="alert-triangle" disabled={!ready} loading={busy} onPress={submit} />
      {!ready ? <Small>Describe what happened first.</Small> : null}
    </Page>
  );
}
