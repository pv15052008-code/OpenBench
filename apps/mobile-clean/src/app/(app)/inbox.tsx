/** Notifications: approvals, reminders, returns to confirm, incidents. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Button, Empty, ErrorNote, H3, Loading, Page, PageHeader, Small } from "@/components/ui";
import { rpc } from "@/lib/api";
import { ago } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { space, usePalette } from "@/lib/theme";

type Note = { id: string; title: string; body: string; booking_id: string | null; read_at: string | null; created_at: string };

export default function Inbox() {
  const router = useRouter();
  const qc = useQueryClient();
  const p = usePalette();
  const q = useQuery({
    queryKey: ["inbox"],
    queryFn: async () => {
      const { data, error } = await supabase.from("notifications").select("id,title,body,booking_id,read_at,created_at").order("created_at", { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return data as Note[];
    },
  });
  const markAll = useMutation({
    mutationFn: () => rpc("mark_notifications_read", { p_ids: null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["inbox"] }); qc.invalidateQueries({ queryKey: ["unread"] }); },
  });
  const open = async (n: Note) => {
    if (!n.read_at) {
      rpc("mark_notifications_read", { p_ids: [n.id] }).then(() => { qc.invalidateQueries({ queryKey: ["inbox"] }); qc.invalidateQueries({ queryKey: ["unread"] }); }).catch(() => {});
    }
    if (n.booking_id) router.push(`/bookings/${n.booking_id}`);
  };
  const unread = (q.data ?? []).filter((n) => !n.read_at).length;

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title="Inbox" intro={unread ? `${unread} unread` : "You're up to date."}
        right={unread ? <Button small kind="secondary" label="Mark all read" loading={markAll.isPending} onPress={() => markAll.mutate()} /> : undefined} />
      <ErrorNote error={q.error ?? markAll.error} retry={() => q.refetch()} />
      {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? <Empty title="No notifications yet" body="Approvals, reminders and incident updates appear here." /> : (
        <View style={{ borderWidth: 1, borderColor: p.rule, borderRadius: 6, overflow: "hidden", backgroundColor: p.surface }}>
          {(q.data ?? []).map((n, i) => (
            <Pressable key={n.id} onPress={() => open(n)} accessibilityRole={n.booking_id ? "link" : "button"}
              accessibilityLabel={`${n.read_at ? "" : "Unread. "}${n.title}. ${n.body}`}
              style={({ pressed }) => ({ flexDirection: "row", gap: space(3), padding: space(4), borderTopWidth: i ? 1 : 0, borderTopColor: p.rule, backgroundColor: pressed ? p.sunken : "transparent" })}>
              <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 8, backgroundColor: n.read_at ? "transparent" : p.brand }} />
              <View style={{ flex: 1, gap: 2 }}>
                <H3 style={{ fontSize: 15, fontWeight: n.read_at ? "400" : undefined }}>{n.title}</H3>
                {n.body ? <Small numberOfLines={3}>{n.body}</Small> : null}
                <Small style={{ color: p.ink3, fontSize: 12 }}>{ago(n.created_at)}</Small>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </Page>
  );
}
