/** Resources you own or manage. */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { ResourceTag, type Resource } from "@/components/domain";
import { Button, Empty, ErrorNote, Loading, Page, PageHeader, useWide } from "@/components/ui";
import { rpc } from "@/lib/api";
import { space } from "@/lib/theme";

export default function Manage() {
  const router = useRouter();
  const wide = useWide();
  const q = useQuery({ queryKey: ["resources", "mine"], queryFn: () => rpc<Resource[]>("list_resources", { p_mine: true }) });
  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title="Listings" intro="Resources you own or manage. Set who may use them, when, and how much."
        right={<Button icon="plus" label="New listing" onPress={() => router.push("/manage/edit")} />} />
      <ErrorNote error={q.error} retry={() => q.refetch()} />
      {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? (
        <Empty title="No listings yet" body="List a piece of equipment or a room so students can request it." action={<Button small label="New listing" onPress={() => router.push("/manage/edit")} />} />
      ) : (
        <View style={{ flexDirection: wide ? "row" : "column", flexWrap: "wrap", gap: space(3) }}>
          {(q.data ?? []).map((r) => <View key={r.id} style={{ width: wide ? "49%" : "100%", flexBasis: wide ? "48%" : "auto", flexGrow: wide ? 1 : 0 }}><ResourceTag r={r} /></View>)}
        </View>
      )}
    </Page>
  );
}
