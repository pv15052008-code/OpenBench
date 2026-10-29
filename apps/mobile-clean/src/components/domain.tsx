/**
 * Components that know about OpenBench's things: resources, bookings, photos,
 * eligibility and the fair-allocation queue.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Link } from "expo-router";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { range } from "@/lib/format";
import { fonts, size, space, usePalette } from "@/lib/theme";
import { pickPhoto, signedUrl, type Picked } from "@/lib/upload";
import { AppError } from "@/lib/api";
import { Badge, Body, Button, CheckRow, H3, Small, StatusTag, type IconName } from "./ui";

export type Resource = {
  id: string; name: string; kind: "equipment" | "space"; category: string; location: string; status: string;
  quantity: number; photo_url?: string | null; department: { code: string; name: string };
  owner: { full_name: string } | null; requirements: string[]; eligible: boolean; pending_requests: number;
  busy_now: boolean; requires_supervision: boolean; manageable: boolean;
};

const CATEGORY_ICON: Record<string, IconName> = {
  "3D printer": "box", "Laser cutter": "zap", "Lab space": "tool", Oscilloscope: "activity", "Microcontroller kit": "cpu",
  "Signal generator": "radio", "Seminar hall": "users", Camera: "camera", Drone: "navigation",
};
export const iconFor = (category: string, kind: string): IconName => CATEGORY_ICON[category] ?? (kind === "space" ? "home" : "package");

/** Short asset code shown on the tag, derived from department and id, like a lab inventory label. */
export const assetCode = (dept: string, id: string) => `${dept}-${id.slice(0, 4).toUpperCase()}`;

/** A resource in a list, laid out like an equipment asset tag. */
export function ResourceTag({ r }: { r: Resource }) {
  const p = usePalette();
  return (
    <Link href={`/resources/${r.id}`} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={`${r.name}, ${r.location}. ${r.eligible ? "You can book this." : "Requirements not met yet."}`}
        style={({ pressed }) => ({ flexDirection: "row", backgroundColor: p.surface, borderWidth: 1, borderColor: p.rule, borderRadius: 6, overflow: "hidden", opacity: pressed ? 0.9 : 1 })}>
        <View style={{ width: 84, backgroundColor: p.sunken, alignItems: "center", justifyContent: "center", borderRightWidth: 1, borderRightColor: p.rule }}>
          {r.photo_url ? (
            <Image source={{ uri: r.photo_url }} style={{ width: 84, height: "100%", minHeight: 96 }} contentFit="cover" accessibilityLabel="" />
          ) : (
            <Feather name={iconFor(r.category, r.kind)} size={28} color={p.brand} />
          )}
        </View>
        <View style={{ flex: 1, padding: space(3), gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space(2) }}>
            <Text style={{ fontFamily: fonts.condensedMedium, fontSize: size.xs, color: p.ink3, letterSpacing: 0.6 }}>
              {assetCode(r.department.code, r.id)}  {r.category}
            </Text>
            {r.status !== "active" ? <Badge label={r.status === "maintenance" ? "Maintenance" : r.status === "draft" ? "Draft" : "Retired"} tone="caution" /> : null}
          </View>
          <H3 numberOfLines={2}>{r.name}</H3>
          <Small numberOfLines={1}>{r.location}</Small>
          <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap", marginTop: 2 }}>
            {r.eligible ? <Badge label="You can book" tone="go" /> : <Badge label={`${r.requirements.length} requirement${r.requirements.length === 1 ? "" : "s"} to meet`} tone="caution" />}
            {r.quantity > 1 ? <Badge label={`${r.quantity} in pool`} /> : null}
            {r.busy_now ? <Badge label="In use now" tone="brand" /> : null}
            {r.pending_requests > 0 ? <Badge label={`${r.pending_requests} waiting`} /> : null}
            {r.requires_supervision ? <Badge label="Supervised" /> : null}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

export type BookingSummary = {
  id: string; status: string; start: string; end: string; quantity: number; purpose: string; course_code?: string | null; decision_reason: string | null;
  resource: { id: string; name: string; location: string; category: string; kind: string };
  user: { full_name: string; department: string | null; year_of_study: number | null } | null;
  open_incidents?: number; competition?: { competing: number; rank?: number } | null;
};

export function BookingRow({ b, showUser }: { b: BookingSummary; showUser?: boolean }) {
  const p = usePalette();
  return (
    <Link href={`/bookings/${b.id}`} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={`${b.resource.name}, ${range(b.start, b.end)}`}
        style={({ pressed }) => ({ paddingVertical: space(3), paddingHorizontal: space(4), backgroundColor: pressed ? p.sunken : p.surface, gap: 4 })}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space(3), alignItems: "flex-start" }}>
          <View style={{ flex: 1, gap: 2 }}>
            <H3 numberOfLines={1}>{b.resource.name}</H3>
            <Small>{range(b.start, b.end)}{b.quantity > 1 ? `, ${b.quantity} units` : ""}</Small>
            {showUser && b.user ? <Small>{b.user.full_name}{b.user.department ? `, ${b.user.department}` : ""}{b.user.year_of_study ? ` year ${b.user.year_of_study}` : ""}</Small> : null}
          </View>
          <StatusTag status={b.status} />
        </View>
        {b.decision_reason && ["blocked", "rejected", "waitlisted"].includes(b.status) ? (
          <Small numberOfLines={2} style={{ color: p.ink3 }}>{b.decision_reason}</Small>
        ) : null}
        {b.competition && b.competition.competing > 1 ? (
          <Small style={{ color: p.caution }}>{b.competition.competing} requests for this slot, this one ranks {b.competition.rank}</Small>
        ) : null}
        {b.open_incidents ? <Small style={{ color: p.stop }}>{b.open_incidents} open incident{b.open_incidents > 1 ? "s" : ""}</Small> : null}
      </Pressable>
    </Link>
  );
}

/** A list of rows inside one bordered block, separated by rules. */
export function RowList({ children }: { children: React.ReactNode[] }) {
  const p = usePalette();
  return (
    <View style={{ borderWidth: 1, borderColor: p.rule, borderRadius: 6, overflow: "hidden", backgroundColor: p.surface }}>
      {children.map((c, i) => (
        <View key={i} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: p.rule }}>{c}</View>
      ))}
    </View>
  );
}

/** A photo from a private bucket, shown through a short-lived signed link. */
export function SignedImage({ bucket, path, size: s = 120 }: { bucket: string; path: string; size?: number }) {
  const p = usePalette();
  const q = useQuery({ queryKey: ["signed", bucket, path], queryFn: () => signedUrl(bucket, path), staleTime: 50 * 60 * 1000 });
  const [failed, setFailed] = useState(false);
  const box = { width: s, height: s, borderRadius: 4, backgroundColor: p.sunken, borderWidth: 1, borderColor: p.rule } as const;
  if (q.data && !failed) {
    return (
      <Pressable accessibilityRole="imagebutton" accessibilityLabel="Open photo full size"
        onPress={() => { if (Platform.OS === "web") window.open(q.data!, "_blank", "noopener"); }}>
        <Image source={{ uri: q.data }} style={box} contentFit="cover" onError={() => setFailed(true)} accessibilityLabel="Condition photo" />
      </Pressable>
    );
  }
  return (
    <View style={[box, { alignItems: "center", justifyContent: "center", padding: 6 }]} accessibilityLabel="Photo not available">
      <Feather name="image" size={20} color={p.ink3} />
      {!q.isLoading ? <Small style={{ fontSize: 11, textAlign: "center", lineHeight: 14 }}>Demo photo</Small> : null}
    </View>
  );
}

/** Lets someone add photos from the camera (phone) or files (web), with previews. */
export function PhotoPicker({ photos, onChange, max = 4, onError, required = true }: { photos: Picked[]; onChange: (p: Picked[]) => void; max?: number; onError: (e: unknown) => void; required?: boolean }) {
  const p = usePalette();
  const add = async (camera: boolean) => {
    try {
      const ph = await pickPhoto(camera);
      if (ph) onChange([...photos, ph].slice(0, max));
    } catch (e) {
      onError(e instanceof AppError ? e : new AppError("Could not open the camera or photos."));
    }
  };
  return (
    <View style={{ gap: space(2) }}>
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        {photos.map((ph, i) => (
          <View key={ph.name}>
            <Image source={{ uri: ph.uri }} style={{ width: 96, height: 96, borderRadius: 4, borderWidth: 1, borderColor: p.rule }} accessibilityLabel={`Photo ${i + 1}`} />
            <Pressable onPress={() => onChange(photos.filter((x) => x !== ph))} accessibilityRole="button" accessibilityLabel={`Remove photo ${i + 1}`}
              style={{ position: "absolute", top: 4, right: 4, backgroundColor: p.ink, borderRadius: 12, width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
              <Feather name="x" size={14} color={p.paper} />
            </Pressable>
          </View>
        ))}
      </View>
      {photos.length < max ? (
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          {Platform.OS !== "web" ? <Button small kind="secondary" icon="camera" label="Take photo" onPress={() => add(true)} /> : null}
          <Button small kind="secondary" icon="image" label={Platform.OS === "web" ? "Add photo" : "Choose from photos"} onPress={() => add(false)} />
        </View>
      ) : null}
      <Small>{photos.length} of {max} photo{max > 1 ? "s" : ""}.{required ? " At least one is required." : ""}</Small>
    </View>
  );
}

export type Check = { key: string; group: string; label: string; ok: boolean; detail?: string };

const GROUP_LABEL: Record<string, string> = {
  account: "Your account", eligibility: "Eligibility", resource: "This resource", time: "Timing", fairness: "Fair use",
};

/** Every automatic check, grouped, so a person sees exactly why a request will pass or not. */
export function CheckList({ checks }: { checks: Check[] }) {
  const groups = ["account", "eligibility", "resource", "time", "fairness"];
  return (
    <View style={{ gap: space(4) }}>
      {groups.map((g) => {
        const items = checks.filter((c) => c.group === g);
        if (!items.length) return null;
        return (
          <View key={g} style={{ gap: space(2) }}>
            <Small style={{ fontFamily: fonts.semibold }}>{GROUP_LABEL[g]}</Small>
            {items.map((c) => <CheckRow key={c.key} ok={c.ok} label={c.label} detail={c.detail} />)}
          </View>
        );
      })}
    </View>
  );
}

/** Where a request stands among competing requests, with the rule spelled out. */
export function CompetitionNote({ c }: { c: { competing: number; rank?: number; rule?: string; reasons?: string[] } | null | undefined }) {
  const p = usePalette();
  if (!c || c.competing < 2) return null;
  return (
    <View style={{ borderLeftWidth: 4, borderLeftColor: p.cautionStrong, backgroundColor: p.cautionSoft, padding: space(3), gap: 4, borderRadius: 2 }}>
      <H3 style={{ fontSize: size.sm }}>{c.competing} requests want this slot. This one is number {c.rank} in line.</H3>
      {c.rule ? <Small>Order: {c.rule.toLowerCase()}.</Small> : null}
      {(c.reasons ?? []).map((r) => <Small key={r}>{r}</Small>)}
    </View>
  );
}

export function Stat({ label, value }: { label: string; value: string | number }) {
  const p = usePalette();
  return (
    <View style={{ gap: 2, minWidth: 110 }}>
      <Text style={{ fontFamily: fonts.condensedBold, fontSize: size.xl, color: p.ink }}>{value}</Text>
      <Small>{label}</Small>
    </View>
  );
}

export function KeyValue({ k, v }: { k: string; v: string | number | null | undefined }) {
  if (v === null || v === undefined || v === "") return null;
  return (
    <View style={{ flexDirection: "row", gap: space(3) }}>
      <Small style={{ width: 130 }}>{k}</Small>
      <Body style={{ flex: 1, fontSize: size.sm, lineHeight: 20 }}>{String(v)}</Body>
    </View>
  );
}
