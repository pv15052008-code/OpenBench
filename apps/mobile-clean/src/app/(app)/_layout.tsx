/**
 * The signed-in shell. Phones get a bottom tab bar; wide screens get a left rail.
 * Also listens for new notifications in real time and refreshes what's on screen.
 */
import { Feather } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect, Stack, usePathname, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Loading, Small, useToast, useWide, type IconName } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { roleLabel } from "@/lib/status";
import { supabase } from "@/lib/supabase";
import { fonts, size, space, usePalette } from "@/lib/theme";

type NavItem = { href: string; label: string; icon: IconName; match: (path: string) => boolean; badge?: number };

export default function AppLayout() {
  const { session, profile, loading, isStaff, isManager, isAdmin } = useAuth();
  const p = usePalette();
  const wide = useWide();
  const qc = useQueryClient();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const unread = useQuery({
    queryKey: ["unread"],
    enabled: !!session,
    queryFn: async () => {
      const { count } = await supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
      return count ?? 0;
    },
    refetchInterval: 60_000,
  });

  // Live updates: a new notification means something changed for this person
  useEffect(() => {
    const uid = session?.user.id;
    if (!uid) return;
    const channel = supabase
      .channel(`notifications:${uid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${uid}` },
        (payload) => {
          const title = (payload.new as { title?: string }).title;
          if (title) toast(title, "brand");
          qc.invalidateQueries();
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user.id, qc, toast]);

  if (loading) return <View style={{ flex: 1, backgroundColor: p.paper, justifyContent: "center" }}><Loading label="Opening OpenBench" /></View>;
  if (!session) return <Redirect href="/sign-in" />;

  const items: NavItem[] = [
    { href: "/", label: "Explore", icon: "search", match: (x) => x === "/" || x.startsWith("/resources") },
    { href: "/bookings", label: "Bookings", icon: "calendar", match: (x) => x.startsWith("/bookings") },
    ...(isStaff ? [{ href: "/review", label: "Review", icon: "check-square" as IconName, match: (x: string) => x.startsWith("/review") }] : []),
    ...(isStaff ? [{ href: "/manage", label: "Listings", icon: "package" as IconName, match: (x: string) => x.startsWith("/manage") }] : []),
    { href: "/incidents", label: "Incidents", icon: "alert-triangle", match: (x) => x.startsWith("/incidents") },
    ...(isStaff ? [{ href: "/verify", label: isAdmin ? "Admin" : "Verify", icon: "shield" as IconName, match: (x: string) => x.startsWith("/verify") }] : []),
    ...(isManager ? [{ href: "/audit", label: "Audit log", icon: "book-open" as IconName, match: (x: string) => x.startsWith("/audit") }] : []),
    { href: "/inbox", label: "Inbox", icon: "bell", match: (x) => x.startsWith("/inbox"), badge: unread.data ?? 0 },
    { href: "/me", label: "Me", icon: "user", match: (x) => x.startsWith("/me") },
  ];

  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.paper }, animation: wide ? "none" : "default" }} />;

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: p.paper }}>
        <View style={{ width: 232, borderRightWidth: 1, borderRightColor: p.rule, backgroundColor: p.surface, paddingVertical: space(6), paddingHorizontal: space(3), gap: space(1) }}>
          <Brand />
          <View style={{ height: space(6) }} />
          {items.map((it) => <RailItem key={it.href} item={it} />)}
          <View style={{ flex: 1 }} />
          {profile ? (
            <View style={{ paddingHorizontal: space(3), gap: 2 }}>
              <Text style={{ fontFamily: fonts.semibold, color: p.ink, fontSize: size.sm }} numberOfLines={1}>{profile.full_name}</Text>
              <Small numberOfLines={1}>{roleLabel(profile.role)}{profile.department ? `, ${profile.department.code}` : ""}</Small>
            </View>
          ) : null}
        </View>
        <View style={{ flex: 1 }}>{stack}</View>
      </View>
    );
  }

  // Phone: five tabs; the rest are reachable from Me
  const phoneTabs = [items[0], items[1], items.find((i) => i.href === "/review") ?? items.find((i) => i.href === "/incidents")!,
                     items.find((i) => i.href === "/inbox")!, items.find((i) => i.href === "/me")!];
  return (
    <View style={{ flex: 1, backgroundColor: p.paper }}>
      <View style={{ flex: 1 }}>{stack}</View>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: p.rule, backgroundColor: p.surface, paddingBottom: Math.max(insets.bottom, 6), paddingTop: 6 }}>
        {phoneTabs.map((it) => <TabItem key={it.href} item={it} />)}
      </View>
    </View>
  );
}

function Brand() {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3) }}>
      <View style={{ width: 28, height: 28, borderRadius: 4, backgroundColor: p.brand, alignItems: "center", justifyContent: "center" }}>
        <Feather name="tool" size={16} color={p.brandInk} />
      </View>
      <Text style={{ fontFamily: fonts.condensedBold, fontSize: size.md, color: p.ink }}>OpenBench</Text>
    </View>
  );
}

function RailItem({ item }: { item: NavItem }) {
  const p = usePalette();
  const router = useRouter();
  const path = usePathname();
  const active = item.match(path);
  return (
    <Pressable onPress={() => router.navigate(item.href as any)} accessibilityRole="link" accessibilityState={{ selected: active }}
      accessibilityLabel={item.badge ? `${item.label}, ${item.badge} unread` : item.label}
      style={({ hovered }: any) => ({ flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(3), height: 40, borderRadius: 4,
        backgroundColor: active ? p.brandSoft : hovered ? p.sunken : "transparent" })}>
      <Feather name={item.icon} size={17} color={active ? p.brand : p.ink2} />
      <Text style={{ flex: 1, fontFamily: active ? fonts.semibold : fonts.medium, fontSize: size.sm, color: active ? p.brand : p.ink }}>{item.label}</Text>
      {item.badge ? <Count n={item.badge} /> : null}
    </Pressable>
  );
}

function TabItem({ item }: { item: NavItem }) {
  const p = usePalette();
  const router = useRouter();
  const path = usePathname();
  const active = item.match(path);
  return (
    <Pressable onPress={() => router.navigate(item.href as any)} accessibilityRole="tab" accessibilityState={{ selected: active }}
      accessibilityLabel={item.badge ? `${item.label}, ${item.badge} unread` : item.label}
      style={{ flex: 1, alignItems: "center", gap: 2, paddingVertical: 4 }}>
      <View>
        <Feather name={item.icon} size={21} color={active ? p.brand : p.ink3} />
        {item.badge ? <View style={{ position: "absolute", top: -4, right: -10 }}><Count n={item.badge} /></View> : null}
      </View>
      <Text style={{ fontFamily: active ? fonts.semibold : fonts.medium, fontSize: 11, color: active ? p.brand : p.ink3 }}>{item.label}</Text>
    </Pressable>
  );
}

function Count({ n }: { n: number }) {
  const p = usePalette();
  return (
    <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: p.stop, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
      <Text style={{ color: "#fff", fontFamily: fonts.semibold, fontSize: 11 }}>{n > 99 ? "99+" : n}</Text>
    </View>
  );
}
