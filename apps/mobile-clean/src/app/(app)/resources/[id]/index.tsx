/**
 * One resource: what it is, the rules, what you need to book it, when it's busy.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { assetCode, iconFor, KeyValue } from "@/components/domain";
import { Badge, Body, Button, CheckRow, Col, Columns, ErrorNote, H3, Loading, Page, PageHeader, Panel, Section, Small, StatusTag } from "@/components/ui";
import { rpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { hhmm, hours, range } from "@/lib/format";
import { space, usePalette } from "@/lib/theme";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ResourceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const p = usePalette();
  const { profile } = useAuth();
  const q = useQuery({ queryKey: ["resource", id], queryFn: () => rpc<any>("get_resource", { p_id: id }), enabled: !!id });

  if (q.isLoading) return <Page><Loading /></Page>;
  if (q.error || !q.data) return <Page><PageHeader title="Resource" back={() => router.back()} /><ErrorNote error={q.error ?? new Error("Resource not found")} retry={() => q.refetch()} /></Page>;
  const r = q.data;
  const unmet = (r.eligibility as any[]).filter((e) => !e.ok);
  const weekly = (r.availability as any[]).filter((a) => a.weekday !== null);
  const blackouts = (r.availability as any[]).filter((a) => a.blackout_date);
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const policy = r.policy;

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title={r.name} back={() => router.back()}
        intro={`${assetCode(r.department.code, r.id)}  ${r.category}, ${r.department.name}`}
        right={r.manageable ? <Button kind="secondary" icon="edit-2" label="Edit listing" onPress={() => router.push(`/manage/edit?id=${r.id}`)} /> : undefined} />

      <Columns>
        <Col flex={3}>
          <View style={{ flexDirection: "row", gap: space(4), alignItems: "flex-start" }}>
            <View style={{ width: 120, height: 120, borderRadius: 6, backgroundColor: p.sunken, borderWidth: 1, borderColor: p.rule, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
              {r.photo_urls?.[0] ? <Image source={{ uri: r.photo_urls[0] }} style={{ width: 120, height: 120 }} contentFit="cover" accessibilityLabel={r.name} /> : <Feather name={iconFor(r.category, r.kind)} size={40} color={p.brand} />}
            </View>
            <View style={{ flex: 1, gap: space(2) }}>
              <Body>{r.description}</Body>
              <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                {r.status !== "active" ? <Badge label={r.status === "maintenance" ? "Under maintenance" : r.status} tone="caution" /> : null}
                {r.requires_supervision ? <Badge label="Supervised use" tone="caution" /> : null}
                {r.quantity > 1 ? <Badge label={`${r.quantity} units in the pool`} /> : null}
              </View>
            </View>
          </View>

          <Panel>
            <KeyValue k="Location" v={r.location} />
            <KeyValue k="Owner" v={r.owner?.full_name} />
            <KeyValue k="Booking length" v={`${r.slot_minutes}-minute steps, up to ${hours(r.max_minutes_per_booking)}`} />
            <KeyValue k="Notice" v={r.lead_time_hours ? `Book at least ${r.lead_time_hours} h ahead, up to ${r.max_advance_days} days` : `Can start right away, up to ${r.max_advance_days} days ahead`} />
            <KeyValue k="Deposit and charges" v={r.deposit_note} />
          </Panel>

          {r.usage_rules ? (
            <Section title="Rules of use">
              <Body>{r.usage_rules}</Body>
            </Section>
          ) : null}

          <Section title="When it's open">
            {weekly.length === 0 ? <Body>Open every day, at any time.</Body> : (
              <View style={{ gap: 4 }}>
                {weekly.map((a, i) => <KeyValue key={i} k={DAYS[a.weekday]} v={`${hhmm(toMin(a.opens_at))}–${hhmm(toMin(a.closes_at))}`} />)}
                <Small>Days not listed are closed.</Small>
              </View>
            )}
            {blackouts.map((b, i) => <Small key={i} style={{ color: p.stop }}>Closed on {b.blackout_date}{b.note ? `: ${b.note}` : ""}</Small>)}
          </Section>

          <Section title="Already booked" hint="Next three weeks. Names are hidden.">
            {(r.busy as any[]).length === 0 ? <Small>Nothing booked yet.</Small> : (
              <View style={{ gap: 4 }}>
                {(r.busy as any[]).map((b, i) => (
                  <Small key={i} style={{ color: b.mine ? p.brand : p.ink2 }}>{range(b.start, b.end)}{b.quantity > 1 ? `, ${b.quantity} units` : ""}{b.mine ? " (yours)" : ""}</Small>
                ))}
              </View>
            )}
          </Section>
        </Col>

        <Col flex={2}>
          <Panel tone={unmet.length ? "caution" : "go"}>
            <H3>{unmet.length ? `You need ${unmet.length} more thing${unmet.length > 1 ? "s" : ""} to book this` : (r.eligibility as any[]).length ? "You meet every requirement" : "No special requirements"}</H3>
            {(r.eligibility as any[]).map((e) => <CheckRow key={e.key} ok={e.ok} label={e.label} detail={e.detail} />)}
            {unmet.some((e) => e.key.startsWith("req:training")) ? (
              <Button small kind="secondary" icon="upload" label="Upload a training certificate" onPress={() => router.push("/me")} />
            ) : null}
            {profile?.verification_status !== "verified" ? <Small>Your account is still waiting for verification.</Small> : null}
          </Panel>

          <Panel>
            <H3>Fair use</H3>
            <Small>Up to {policy.max_bookings_per_week} bookings and {hours(policy.max_minutes_per_week)} a week per person{policy.cooldown_hours ? `, with ${policy.cooldown_hours} h between uses` : ""}. When requests clash, first-time users go first, then whoever has used it least this week.</Small>
            <Small>You this week: {r.my_week?.bookings ?? 0} booking{(r.my_week?.bookings ?? 0) === 1 ? "" : "s"}, {hours(r.my_week?.minutes ?? 0)}.</Small>
          </Panel>

          {r.status === "active" ? (
            <Button label="Choose a time" icon="calendar" onPress={() => router.push(`/resources/${r.id}/request`)}
              accessibilityHint="Pick a slot and see every check before you send the request" />
          ) : <Small>Booking is paused while this is {r.status}.</Small>}

          {(r.my_bookings as any[]).length ? (
            <Section title="Your bookings of this">
              <View style={{ gap: space(2) }}>
                {(r.my_bookings as any[]).map((b) => (
                  <Pressable key={b.id} onPress={() => router.push(`/bookings/${b.id}`)} accessibilityRole="link"
                    style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space(2), minHeight: 36 }}>
                    <Small style={{ flex: 1, color: p.brand }}>{range(b.start, b.end)}</Small>
                    <StatusTag status={b.status} />
                  </Pressable>
                ))}
              </View>
            </Section>
          ) : null}
        </Col>
      </Columns>
    </Page>
  );
}
