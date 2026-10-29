/** The full register of important actions, newest first. Managers and admins. */
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Chip, Empty, ErrorNote, Ledger, Loading, Page, PageHeader, Panel, Small } from "@/components/ui";
import { rpc } from "@/lib/api";
import { full } from "@/lib/format";
import { actionLabel, roleLabel } from "@/lib/status";
import { space } from "@/lib/theme";

const ENTITIES = [[null, "Everything"], ["booking", "Bookings"], ["incident", "Incidents"], ["qualification", "Training"], ["resource", "Resources"], ["profile", "Accounts"]] as const;

export default function Audit() {
  const router = useRouter();
  const [entity, setEntity] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["audit", entity],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => rpc<any[]>("audit_feed", { p_entity: entity, p_limit: 50, p_before: pageParam }),
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1].id : undefined),
  });
  const rows = (q.data?.pages ?? []).flat();

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title="Audit log" intro="Written by the database on every change, so it can't be skipped or edited. Nobody, including admins, can delete entries." />
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        {ENTITIES.map(([v, l]) => <Chip key={l} label={l} selected={entity === v} onPress={() => setEntity(v)} />)}
      </View>
      <ErrorNote error={q.error} retry={() => q.refetch()} />
      {q.isLoading ? <Loading /> : rows.length === 0 ? <Empty title="No entries" /> : (
        <Panel>
          <Ledger fmt={full} entries={rows.map((r) => ({
            at: r.at, to: r.to, reason: r.reason,
            title: `${actionLabel(r.action)}${r.metadata?.resource ? `: ${r.metadata.resource}` : r.metadata?.name ? `: ${r.metadata.name}` : ""}`,
            who: r.actor?.full_name ?? "System", role: r.actor_role ? roleLabel(r.actor_role) : null,
          }))} />
        </Panel>
      )}
      {rows.length ? <Small>Showing {rows.length} entries. Booking entries link to the full record from each booking's page.</Small> : null}
      {q.hasNextPage ? <Button kind="secondary" label="Load older entries" loading={q.isFetchingNextPage} onPress={() => q.fetchNextPage()} style={{ alignSelf: "flex-start" }} /> : null}
    </Page>
  );
}
