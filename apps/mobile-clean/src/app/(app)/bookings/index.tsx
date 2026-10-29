/** Your bookings, split into what's coming, what's waiting, and what's done. */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { BookingRow, RowList, type BookingSummary } from "@/components/domain";
import { Button, Chip, Empty, ErrorNote, Loading, Page, PageHeader } from "@/components/ui";
import { rpc } from "@/lib/api";
import { space } from "@/lib/theme";

const TABS = {
  current: { label: "Current", states: ["approved", "checked_in", "overdue", "returned", "disputed"] },
  waiting: { label: "Waiting", states: ["pending_review", "waitlisted", "blocked"] },
  past: { label: "Past", states: ["closed", "rejected", "cancelled", "no_show"] },
} as const;

export default function Bookings() {
  const router = useRouter();
  const [tab, setTab] = useState<keyof typeof TABS>("current");
  const q = useQuery({ queryKey: ["my-bookings"], queryFn: () => rpc<BookingSummary[]>("my_bookings") });
  const all = q.data ?? [];
  const rows = all.filter((b) => (TABS[tab].states as readonly string[]).includes(b.status))
    .sort((a, b) => (tab === "past" ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start)));

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title="Bookings" intro="Everything you've requested, with the reason behind every decision." />
      <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => {
          const n = all.filter((b) => (TABS[k].states as readonly string[]).includes(b.status)).length;
          return <Chip key={k} label={`${TABS[k].label} (${n})`} selected={tab === k} onPress={() => setTab(k)} />;
        })}
      </View>
      <ErrorNote error={q.error} retry={() => q.refetch()} />
      {q.isLoading ? <Loading /> : rows.length === 0 ? (
        <Empty title={tab === "current" ? "Nothing booked right now" : tab === "waiting" ? "No requests waiting" : "No past bookings yet"}
          body="Find a resource on Explore and choose a time." action={<Button small label="Explore resources" icon="search" onPress={() => router.navigate("/")} />} />
      ) : (
        <RowList>{rows.map((b) => <BookingRow key={b.id} b={b} />)}</RowList>
      )}
    </Page>
  );
}
