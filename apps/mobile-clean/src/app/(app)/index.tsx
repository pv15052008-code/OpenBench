/**
 * Explore: find a resource by name, category or by describing the need.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { ResourceTag, type BookingSummary, type Resource } from "@/components/domain";
import { Body, Button, Chip, Empty, ErrorNote, Field, H3, Loading, Page, PageHeader, Panel, Small, StatusTag, useWide } from "@/components/ui";
import { engine, engineConfigured, rpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { range } from "@/lib/format";
import { space, usePalette } from "@/lib/theme";

export default function Explore() {
  const { profile } = useAuth();
  const p = usePalette();
  const wide = useWide();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [need, setNeed] = useState("");
  const [smart, setSmart] = useState<{ results: (Resource & { reason: string })[]; source: string } | null>(null);
  const [smartBusy, setSmartBusy] = useState(false);
  const [smartErr, setSmartErr] = useState<unknown>(null);

  const list = useQuery({ queryKey: ["resources"], queryFn: () => rpc<Resource[]>("list_resources", {}) });
  const mine = useQuery({ queryKey: ["my-bookings"], queryFn: () => rpc<BookingSummary[]>("my_bookings") });

  const categories = useMemo(() => Array.from(new Set((list.data ?? []).map((r) => r.category))).sort(), [list.data]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (list.data ?? []).filter((r) =>
      r.status === "active" &&
      (!category || r.category === category) &&
      (!eligibleOnly || r.eligible) &&
      (!term || `${r.name} ${r.category} ${r.location} ${r.department.code}`.toLowerCase().includes(term)));
  }, [list.data, q, category, eligibleOnly]);

  const next = (mine.data ?? []).filter((b) => ["approved", "checked_in", "overdue"].includes(b.status))
    .sort((a, b) => a.start.localeCompare(b.start))[0];

  const askSmart = async () => {
    setSmartBusy(true); setSmartErr(null);
    try { setSmart(await engine("/ai/search", { query: need })); } catch (e) { setSmartErr(e); } finally { setSmartBusy(false); }
  };

  return (
    <Page onRefresh={() => { list.refetch(); mine.refetch(); }} refreshing={list.isRefetching}>
      <PageHeader title={`Hello, ${profile?.full_name.split(" ")[0] ?? "there"}`} intro="Find equipment and rooms across campus. Each listing shows what you need before you can book it." />

      {profile && profile.verification_status !== "verified" ? (
        <Panel tone="caution">
          <H3>Your account is waiting for verification</H3>
          <Small>You can browse now. An admin checks your roll number before you can book. Fill in your department and year under Me so they can find you.</Small>
        </Panel>
      ) : null}

      {next ? (
        <Link href={`/bookings/${next.id}`} asChild>
          <Pressable accessibilityRole="link" style={{ borderLeftWidth: 4, borderLeftColor: p.brand, backgroundColor: p.brandSoft, padding: space(4), borderRadius: 2, gap: 4 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space(3) }}>
              <H3 style={{ flex: 1 }}>{next.status === "approved" ? "Up next" : "In your hands"}: {next.resource.name}</H3>
              <StatusTag status={next.status} />
            </View>
            <Small>{range(next.start, next.end)}, {next.resource.location}</Small>
          </Pressable>
        </Link>
      ) : null}

      <View style={{ gap: space(3) }}>
        <Field label="Search by name, category, room or department" value={q} onChangeText={setQ} placeholder="Oscilloscope, B-204, camera…" returnKeyType="search" />
        <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
          <Chip label="All" selected={!category} onPress={() => setCategory(null)} />
          {categories.map((c) => <Chip key={c} label={c} selected={category === c} onPress={() => setCategory(category === c ? null : c)} />)}
          <Chip label="Only what I can book" icon="check" selected={eligibleOnly} onPress={() => setEligibleOnly(!eligibleOnly)} />
        </View>
      </View>

      {engineConfigured ? (
        <Panel>
          <H3>Not sure what you need?</H3>
          <View style={{ flexDirection: wide ? "row" : "column", gap: space(3), alignItems: wide ? "flex-end" : "stretch" }}>
            <View style={{ flex: 1 }}>
              <Field label="Describe the job" value={need} onChangeText={setNeed} placeholder="Measure a 5 MHz signal from my circuit this weekend" maxLength={300} onSubmitEditing={askSmart} />
            </View>
            <Button label="Suggest resources" icon="compass" kind="secondary" onPress={askSmart} loading={smartBusy} disabled={need.trim().length < 3} />
          </View>
          <ErrorNote error={smartErr} />
          {smart ? (
            smart.results.length ? (
              <View style={{ gap: space(2) }}>
                <Small>{smart.source === "gemini" ? "Suggested by AI from the catalogue. Check the requirements on each." : "Matched by keywords (AI not configured)."}</Small>
                {smart.results.map((r) => (
                  <View key={r.id} style={{ gap: 4 }}>
                    <ResourceTag r={r} />
                    <Small style={{ paddingLeft: space(1) }}>{r.reason}</Small>
                  </View>
                ))}
              </View>
            ) : <Small>Nothing in the catalogue fits that. Try different words, or ask a lab owner.</Small>
          ) : null}
        </Panel>
      ) : null}

      <ErrorNote error={list.error} retry={() => list.refetch()} />
      {list.isLoading ? <Loading label="Loading resources" /> : shown.length === 0 ? (
        <Empty title="No resources match" body={eligibleOnly ? "Turn off “Only what I can book” to see everything, then check what each one needs." : "Try another word or category."} />
      ) : (
        <View style={{ flexDirection: wide ? "row" : "column", flexWrap: "wrap", gap: space(3) }}>
          {shown.map((r) => (
            <View key={r.id} style={{ width: wide ? "49%" : "100%", flexGrow: wide ? 1 : 0, flexBasis: wide ? "48%" : "auto" }}>
              <ResourceTag r={r} />
            </View>
          ))}
        </View>
      )}
      {!list.isLoading ? <Body style={{ color: p.ink3 }}>{shown.length} of {(list.data ?? []).filter((r) => r.status === "active").length} active resources</Body> : null}
    </Page>
  );
}
