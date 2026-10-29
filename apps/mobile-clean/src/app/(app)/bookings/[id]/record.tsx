/**
 * Check-in and return: the person using the resource ticks the owner's checklist,
 * adds photos and a note. This becomes the before/after condition record.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { PhotoPicker } from "@/components/domain";
import { Body, Button, ErrorNote, Field, Loading, Page, PageHeader, Panel, Section, Small, useToast } from "@/components/ui";
import { rpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { range } from "@/lib/format";
import { space, usePalette } from "@/lib/theme";
import { upload, type Picked } from "@/lib/upload";

type Item = { key: string; label: string; ok: boolean | null; note: string };

export default function Record() {
  const { id, phase } = useLocalSearchParams<{ id: string; phase: "checkin" | "return" }>();
  const isReturn = phase === "return";
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const p = usePalette();
  const { profile } = useAuth();
  const q = useQuery({ queryKey: ["booking", id], queryFn: () => rpc<any>("get_booking", { p_id: id }), enabled: !!id });
  const [items, setItems] = useState<Item[]>([]);
  const [photos, setPhotos] = useState<Picked[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (q.data && items.length === 0) {
      const template = (q.data.checklist_template ?? []) as { key: string; label: string }[];
      setItems((template.length ? template : [{ key: "condition", label: "Overall condition as expected" }]).map((t) => ({ ...t, ok: null, note: "" })));
    }
  }, [q.data, items.length]);

  if (q.isLoading) return <Page><Loading /></Page>;
  if (!q.data) return <Page><ErrorNote error={q.error ?? new Error("Booking not found")} /></Page>;
  const b = q.data;

  const answered = items.every((i) => i.ok !== null);
  const notesNeeded = items.some((i) => i.ok === false && !i.note.trim());
  const ready = answered && !notesNeeded && photos.length > 0;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const paths: string[] = [];
      for (const ph of photos) paths.push(await upload("condition-photos", `${id}/${profile!.id}`, ph));
      await rpc(isReturn ? "return_booking" : "check_in", {
        p_booking: id,
        p_checklist: items.map(({ key, label, ok, note }) => ({ key, label, ok, note: note.trim() })),
        p_photos: paths, p_notes: notes.trim(),
      });
      qc.invalidateQueries();
      toast(isReturn ? "Returned. The owner will confirm the condition." : "Checked in. Return it before the slot ends.");
      if (router.canGoBack()) router.back(); else router.replace(`/bookings/${id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<Item>) => setItems((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Page>
      <PageHeader title={isReturn ? "Return" : "Check in"} back={() => router.back()} intro={`${b.resource.name}, ${range(b.start, b.end)}`} />
      <Body style={{ maxWidth: 640 }}>
        {isReturn
          ? "Record the condition as you hand it back. The owner compares this with your check-in record before closing the booking."
          : "Record the condition before you start. If something is already wrong, say so now: it protects you later."}
      </Body>

      <Section title="Checklist" hint="Mark each item. Anything not OK needs a short note.">
        <Panel>
          {items.map((it, i) => (
            <View key={it.key} style={{ gap: space(2), paddingVertical: space(1) }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space(3), flexWrap: "wrap" }}>
                <Body style={{ flex: 1, minWidth: 180 }}>{it.label}</Body>
                {([true, false] as const).map((v) => (
                  <Pressable key={String(v)} onPress={() => set(i, { ok: v })} accessibilityRole="radio" accessibilityState={{ checked: it.ok === v }} aria-checked={it.ok === v}
                    accessibilityLabel={`${it.label}: ${v ? "OK" : "Not OK"}`}
                    style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space(3), minHeight: 40, borderRadius: 4, borderWidth: 1,
                      borderColor: it.ok === v ? (v ? p.go : p.stop) : p.rule, backgroundColor: it.ok === v ? (v ? p.goSoft : p.stopSoft) : p.surface }}>
                    <Feather name={v ? "check" : "x"} size={15} color={it.ok === v ? (v ? p.go : p.stop) : p.ink3} />
                    <Small style={{ color: it.ok === v ? (v ? p.go : p.stop) : p.ink2 }}>{v ? "OK" : "Not OK"}</Small>
                  </Pressable>
                ))}
              </View>
              {it.ok === false ? <Field label="What's wrong" value={it.note} onChangeText={(t) => set(i, { note: t })} maxLength={200} /> : null}
            </View>
          ))}
        </Panel>
      </Section>

      <Section title="Photos" hint="Show the whole item and anything noted above.">
        <PhotoPicker photos={photos} onChange={setPhotos} onError={setError} />
      </Section>

      <Field label="Note (optional)" value={notes} onChangeText={setNotes} multiline maxLength={2000} placeholder={isReturn ? "Filament used, anything the next person should know" : "Anything unusual"} />
      <ErrorNote error={error} />
      <Button label={isReturn ? "Record return" : "Record check-in"} icon={isReturn ? "log-out" : "log-in"} disabled={!ready} loading={busy} onPress={submit} />
      {!ready ? <Small>{!answered ? "Mark every checklist item." : notesNeeded ? "Add a note for each item marked Not OK." : "Add at least one photo."}</Small> : null}
    </Page>
  );
}
