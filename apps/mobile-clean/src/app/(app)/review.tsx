/**
 * Review queue for owners and managers: requests to decide, returns to confirm,
 * and what's in use. Competing requests are shown together with their rank.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { BookingRow, RowList, type BookingSummary } from "@/components/domain";
import { Badge, Button, Chip, Empty, ErrorNote, H3, Loading, Page, PageHeader, Panel, Small, StatusTag } from "@/components/ui";
import { rpc } from "@/lib/api";
import { hours, range } from "@/lib/format";
import { space, usePalette } from "@/lib/theme";

type QueueItem = BookingSummary & {
  checks: { ok: boolean; label: string }[] | null;
  competition: { competing: number; rank?: number; reasons?: string[] } | null;
  user_week: { bookings: number; minutes: number } | null;
  user_strikes: number; user_history: number; user_incidents: number;
  ai_brief: { summary: string } | null;
};

export default function Review() {
  const router = useRouter();
  const p = usePalette();
  const [tab, setTab] = useState<"requests" | "returns" | "active">("requests");
  const q = useQuery({
    queryKey: ["review"],
    queryFn: async () => {
      rpc("sweep_due").catch(() => {});  // keeps no-shows and overdue returns current even if the cron is asleep
      return rpc<{ requests: QueueItem[]; returns: BookingSummary[]; active: BookingSummary[] }>("review_queue");
    },
  });
  const data = q.data;

  // Group competing requests (same resource, overlapping time) so they're decided side by side
  const groups: QueueItem[][] = [];
  for (const r of (data?.requests ?? []).slice().sort((a, b) => a.start.localeCompare(b.start))) {
    const g = groups.find((g) => g[0].resource.id === r.resource.id && g.some((x) => x.start < r.end && r.start < x.end));
    if (g) g.push(r); else groups.push([r]);
  }
  groups.forEach((g) => g.sort((a, b) => (a.competition?.rank ?? 99) - (b.competition?.rank ?? 99)));

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title="Review" intro="Decide requests for the resources you manage. Every decision needs a reason, and the student sees it." />
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        <Chip label={`Requests (${data?.requests.length ?? 0})`} selected={tab === "requests"} onPress={() => setTab("requests")} />
        <Chip label={`Returns to confirm (${data?.returns.length ?? 0})`} selected={tab === "returns"} onPress={() => setTab("returns")} />
        <Chip label={`In use and upcoming (${data?.active.length ?? 0})`} selected={tab === "active"} onPress={() => setTab("active")} />
      </View>
      <ErrorNote error={q.error} retry={() => q.refetch()} />
      {q.isLoading ? <Loading /> : tab === "requests" ? (
        groups.length === 0 ? <Empty title="No requests waiting" body="New requests appear here as soon as students send them." /> : (
          <View style={{ gap: space(4) }}>
            {groups.map((g) => (
              <View key={g[0].id} style={{ gap: space(2) }}>
                {g.length > 1 ? (
                  <View style={{ borderLeftWidth: 4, borderLeftColor: p.cautionStrong, paddingLeft: space(3), gap: 2 }}>
                    <H3>{g.length} requests compete for {g[0].resource.name}</H3>
                    <Small>Ranked by the fair-use order: first-time users, then least use this week, then course-linked, then earliest. Approving one moves the others that no longer fit to the waitlist.</Small>
                  </View>
                ) : null}
                {g.map((r) => <QueueCard key={r.id} r={r} onOpen={() => router.push(`/bookings/${r.id}`)} />)}
              </View>
            ))}
          </View>
        )
      ) : tab === "returns" ? (
        (data?.returns.length ?? 0) === 0 ? <Empty title="No returns to confirm" body="When someone returns an item, compare their photos and close the booking here." /> :
          <RowList>{data!.returns.map((b) => <BookingRow key={b.id} b={b} showUser />)}</RowList>
      ) : (
        (data?.active.length ?? 0) === 0 ? <Empty title="Nothing in use or coming up this week" /> :
          <RowList>{data!.active.map((b) => <BookingRow key={b.id} b={b} showUser />)}</RowList>
      )}
    </Page>
  );
}

function QueueCard({ r, onOpen }: { r: QueueItem; onOpen: () => void }) {
  const p = usePalette();
  const failed = (r.checks ?? []).filter((c) => !c.ok);
  const rank = r.competition && r.competition.competing > 1 ? r.competition.rank : null;
  return (
    <Pressable onPress={onOpen} accessibilityRole="link" accessibilityLabel={`Review request from ${r.user?.full_name} for ${r.resource.name}`}>
      {({ pressed }) => (
        <Panel style={{ opacity: pressed ? 0.9 : 1, borderLeftWidth: rank === 1 ? 4 : 1, borderLeftColor: rank === 1 ? p.go : p.rule }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space(3), flexWrap: "wrap" }}>
            <View style={{ flex: 1, gap: 2, minWidth: 220 }}>
              <View style={{ flexDirection: "row", gap: space(2), alignItems: "center", flexWrap: "wrap" }}>
                {rank ? <Badge label={`Rank ${rank}`} tone={rank === 1 ? "go" : "neutral"} /> : null}
                <H3>{r.user?.full_name}</H3>
                <Small>{r.user?.department ?? ""}{r.user?.year_of_study ? `, year ${r.user.year_of_study}` : ""}</Small>
              </View>
              <Small>{r.resource.name}: {range(r.start, r.end)}{r.quantity > 1 ? `, ${r.quantity} units` : ""}</Small>
            </View>
            <StatusTag status={r.status} />
          </View>
          <Small style={{ color: p.ink }} numberOfLines={3}>“{r.purpose}”{r.course_code ? `  ${r.course_code}` : ""}</Small>
          <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
            <Badge label={`${hours(r.user_week?.minutes ?? 0)} used this week`} />
            <Badge label={r.user_history ? `${r.user_history} completed booking${r.user_history > 1 ? "s" : ""}` : "First booking"} tone={r.user_history ? "neutral" : "brand"} />
            {r.user_strikes ? <Badge label={`${r.user_strikes} strike${r.user_strikes > 1 ? "s" : ""}`} tone="stop" /> : null}
            {r.user_incidents ? <Badge label={`${r.user_incidents} past incident${r.user_incidents > 1 ? "s" : ""}`} tone="caution" /> : null}
            {failed.length ? <Badge label={`${failed.length} check${failed.length > 1 ? "s" : ""} failed`} tone="stop" /> : null}
          </View>
          {rank && r.competition?.reasons?.length ? <Small>{r.competition.reasons.join(". ")}.</Small> : null}
          {r.ai_brief ? <Small style={{ fontStyle: "italic" }}>{r.ai_brief.summary}</Small> : null}
          <Button small kind="secondary" label="Open and decide" onPress={onOpen} style={{ alignSelf: "flex-start" }} />
        </Panel>
      )}
    </Pressable>
  );
}
