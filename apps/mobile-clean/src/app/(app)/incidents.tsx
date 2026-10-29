/**
 * Incidents: damage, delays and disputes. Students see their own; owners see their
 * resources'; department managers resolve them and decide on strikes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { SignedImage } from "@/components/domain";
import { Badge, Body, Button, Chip, Empty, ErrorNote, H3, Loading, Page, PageHeader, Panel, ReasonDialog, Small, Toggle, useToast } from "@/components/ui";
import { engine, engineConfigured, rpc } from "@/lib/api";
import { ago, range } from "@/lib/format";
import { space, usePalette } from "@/lib/theme";

export default function Incidents() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const p = usePalette();
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [resolving, setResolving] = useState<any | null>(null);
  const [strike, setStrike] = useState(false);
  const q = useQuery({ queryKey: ["incidents"], queryFn: () => rpc<any[]>("incident_feed") });
  const summarise = useMutation({
    mutationFn: (incidentId: string) => engine(`/ai/incident/${incidentId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["incidents"] }),
  });
  const startReview = useMutation({
    mutationFn: (incidentId: string) => rpc("review_incident", { p_incident: incidentId }),
    onSuccess: () => { toast("Marked as under review"); qc.invalidateQueries(); },
  });

  const rows = (q.data ?? []).filter((i) => (filter === "open" ? i.status !== "resolved" : i.status === "resolved"));

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title="Incidents" intro="Damage, delays and disputes on bookings you're part of. A department manager decides each outcome; the system never applies a penalty by itself." />
      <View style={{ flexDirection: "row", gap: space(2) }}>
        <Chip label={`Open (${(q.data ?? []).filter((i) => i.status !== "resolved").length})`} selected={filter === "open"} onPress={() => setFilter("open")} />
        <Chip label="Resolved" selected={filter === "resolved"} onPress={() => setFilter("resolved")} />
      </View>
      <ErrorNote error={q.error ?? summarise.error ?? startReview.error} retry={() => q.refetch()} />
      {q.isLoading ? <Loading /> : rows.length === 0 ? (
        <Empty title={filter === "open" ? "No open incidents" : "Nothing resolved yet"} body="Report a problem from any booking's page." />
      ) : rows.map((inc) => (
        <Panel key={inc.id} tone={inc.status === "resolved" ? undefined : inc.severity === "high" ? "stop" : undefined}>
          <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap", alignItems: "center" }}>
            <Badge label={`${inc.severity[0].toUpperCase()}${inc.severity.slice(1)} severity`} tone={inc.severity === "high" ? "stop" : inc.severity === "medium" ? "caution" : "neutral"} />
            <Badge label={inc.type} />
            <Badge label={inc.status.replace("_", " ")} tone={inc.status === "resolved" ? "go" : "caution"} />
          </View>
          <H3>{inc.booking.resource.name}</H3>
          <Small>{inc.booking.user?.full_name}, {range(inc.booking.start, inc.booking.end)}</Small>
          <Body style={{ fontSize: 15 }}>{inc.description}</Body>
          <Small>Reported by {inc.reported_by_card?.full_name ?? "the system"}, {ago(inc.created_at)}{inc.estimated_cost ? `. Estimated ₹${inc.estimated_cost}` : ""}</Small>
          {(inc.photo_paths as string[]).length ? (
            <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
              {(inc.photo_paths as string[]).map((ph: string) => <SignedImage key={ph} bucket="incident-photos" path={ph} size={88} />)}
            </View>
          ) : null}
          {inc.ai_summary ? (
            <View style={{ borderLeftWidth: 2, borderLeftColor: p.brand, paddingLeft: space(3), gap: 2 }}>
              <Small style={{ color: p.ink }}>{inc.ai_summary.summary}</Small>
              {(inc.ai_summary.changed_items ?? []).map((c: string) => <Small key={c}>{c}</Small>)}
              <Small style={{ color: p.ink3 }}>{inc.ai_summary.source === "gemini" ? "AI summary, advisory only." : "Rule-based summary."}</Small>
            </View>
          ) : null}
          {inc.resolution ? <Small style={{ color: p.ink }}>Resolved by {inc.resolved_by_card?.full_name}: {inc.resolution}{inc.strike_applied ? " A strike was recorded." : ""}</Small> : null}
          <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
            <Button small kind="secondary" label="Open booking" onPress={() => router.push(`/bookings/${inc.booking_id}`)} />
            {inc.can_resolve && engineConfigured ? <Button small kind="secondary" icon="file-text" label="Summarise" loading={summarise.isPending && summarise.variables === inc.id} onPress={() => summarise.mutate(inc.id)} /> : null}
            {inc.can_resolve && inc.status === "open" ? <Button small kind="secondary" label="Start review" onPress={() => startReview.mutate(inc.id)} /> : null}
            {inc.can_resolve ? <Button small label="Resolve" onPress={() => { setStrike(false); setResolving(inc); }} /> : null}
          </View>
        </Panel>
      ))}

      <ReasonDialog visible={!!resolving} title="Resolve incident" confirmLabel="Resolve" minLength={10}
        body="Write what was found and what happens next. Both people see this."
        extra={<Toggle label="Record a strike against the student" hint="Three strikes suspend booking for 14 days. Only use this when the student was responsible." value={strike} onChange={setStrike} />}
        onCancel={() => setResolving(null)}
        onConfirm={async (reason) => {
          await rpc("resolve_incident", { p_incident: resolving.id, p_resolution: reason, p_apply_strike: strike });
          setResolving(null); toast("Incident resolved"); qc.invalidateQueries();
        }} />
    </Page>
  );
}
