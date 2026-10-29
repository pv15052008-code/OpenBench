/**
 * Request a slot. Every automatic check runs live as the slot changes, so the
 * student sees the outcome (review, waitlist or blocked, and why) before sending.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { CheckList, type Check } from "@/components/domain";
import { Body, Button, Chip, Col, Columns, ErrorNote, Field, H3, Loading, Page, PageHeader, Panel, Section, Small, Toggle, useToast } from "@/components/ui";
import { rpc } from "@/lib/api";
import { day, hhmm, hours, istDate, istInstant, istMinutes, istWeekday } from "@/lib/format";
import { space, usePalette } from "@/lib/theme";

type Preview = { checks: Check[]; all_passed: boolean; slot_free: boolean; competing_requests: number; outcome: "pending_review" | "waitlisted" | "blocked" };

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export default function RequestBooking() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const p = usePalette();
  const res = useQuery({ queryKey: ["resource", id], queryFn: () => rpc<any>("get_resource", { p_id: id }), enabled: !!id });
  const courses = useQuery({ queryKey: ["courses"], queryFn: () => rpc<{ code: string; name: string; department: string }[]>("list_courses") });

  const [date, setDate] = useState(istDate(new Date()));
  const [start, setStart] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [purpose, setPurpose] = useState("");
  const [course, setCourse] = useState("");
  const [ack, setAck] = useState(false);

  const r = res.data;
  const step = r ? Math.min(r.slot_minutes, 60) : 30;

  const dates = useMemo(() => {
    if (!r) return [];
    const out: string[] = [];
    const n = Math.min(r.max_advance_days, 21);
    for (let i = 0; i <= n; i++) out.push(istDate(new Date(Date.now() + i * 86400000)));
    return out;
  }, [r]);

  const durations = useMemo(() => {
    if (!r) return [];
    const set = new Set<number>();
    for (let k = 1; k <= 8; k++) set.add(r.slot_minutes * k);
    [1440, 2880, 4320, 10080].forEach((m) => set.add(m));
    return [...set].filter((m) => m <= r.max_minutes_per_booking && m % r.slot_minutes === 0).sort((a, b) => a - b);
  }, [r]);

  // Opening window for the chosen day (null = closed), in minutes since midnight IST
  const window = useMemo(() => {
    if (!r) return null;
    const rules = (r.availability as any[]).filter((a) => a.weekday !== null);
    if ((r.availability as any[]).some((a) => a.blackout_date === date)) return null;
    if (!rules.length) return { open: 0, close: 24 * 60 };
    const wd = istWeekday(date);
    const rule = rules.find((a) => a.weekday === wd);
    if (!rule) return null;
    const close = rule.closes_at.startsWith("23:59") ? 24 * 60 : toMin(rule.closes_at);
    return { open: toMin(rule.opens_at), close };
  }, [r, date]);

  const isToday = date === istDate(new Date());
  const nowFloor = Math.floor(istMinutes(new Date()) / 15) * 15;

  const starts = useMemo(() => {
    if (!r || !window) return [] as number[];
    const earliest = isToday ? Math.max(window.open, nowFloor + (r.lead_time_hours ? r.lead_time_hours * 60 : 0)) : window.open;
    const out: number[] = [];
    // "Now" option when the resource needs no notice
    if (isToday && r.lead_time_hours === 0 && nowFloor >= window.open && nowFloor % step !== 0) out.push(nowFloor);
    const first = Math.ceil(earliest / step) * step;
    for (let m = first; m + r.slot_minutes <= window.close || (r.max_minutes_per_booking >= 1440 && m < window.close); m += step) out.push(m);
    return out;
  }, [r, window, isToday, nowFloor, step]);

  // Keep selections valid as the day changes
  useEffect(() => { if (start !== null && !starts.includes(start)) setStart(null); }, [starts, start]);
  useEffect(() => { if (duration === null && durations.length) setDuration(durations[0]); }, [durations, duration]);

  const startAt = start !== null ? istInstant(date, start) : null;
  const endAt = startAt && duration ? new Date(startAt.getTime() + duration * 60000) : null;

  const busy = (r?.busy ?? []) as { start: string; end: string; quantity: number }[];
  const taken = (m: number) => {
    if (!duration) return false;
    const s = istInstant(date, m).getTime(), e = s + duration * 60000;
    if (r?.quantity > 1) return busy.filter((b) => new Date(b.start).getTime() < e && new Date(b.end).getTime() > s).reduce((n, b) => n + b.quantity, 0) + qty > r.quantity;
    return busy.some((b) => new Date(b.start).getTime() < e && new Date(b.end).getTime() > s);
  };

  const preview = useQuery({
    queryKey: ["preview", id, startAt?.toISOString(), endAt?.toISOString(), qty, course.trim().toUpperCase()],
    enabled: !!startAt && !!endAt,
    queryFn: () => rpc<Preview>("preview_booking", {
      p_resource: id, p_start: startAt!.toISOString(), p_end: endAt!.toISOString(), p_quantity: qty, p_course: course.trim() || null,
    }),
    staleTime: 5_000,
  });

  const courseOk = !course.trim() || /^[A-Za-z]{2,4}[\s-]?[0-9]{3}$/.test(course.trim());
  const submit = useMutation({
    mutationFn: () => rpc<{ id: string; status: string }>("request_booking", {
      p_resource: id, p_start: startAt!.toISOString(), p_end: endAt!.toISOString(), p_quantity: qty,
      p_purpose: purpose.trim(), p_course: course.trim() || null, p_deposit_ack: ack,
    }),
    onSuccess: (out) => {
      qc.invalidateQueries();
      toast(out.status === "pending_review" ? "Request sent to the owner" : out.status === "waitlisted" ? "You're on the waitlist" : "Request recorded as blocked", out.status === "blocked" ? "stop" : "go");
      router.replace(`/bookings/${out.id}`);
    },
  });

  if (res.isLoading) return <Page><Loading /></Page>;
  if (!r) return <Page><ErrorNote error={res.error ?? new Error("Resource not found")} /></Page>;

  const pv = preview.data;
  const outcomeText = !pv ? null : pv.outcome === "pending_review"
    ? { tone: "go" as const, title: "This goes to the owner for review", body: pv.competing_requests ? `${pv.competing_requests} other request(s) want an overlapping slot. The fair-use order decides who goes first.` : "Every automatic check passes." }
    : pv.outcome === "waitlisted"
      ? { tone: "caution" as const, title: "This slot is taken: you'll join the waitlist", body: "If it frees up, your request moves back to review automatically. Or pick a free time." }
      : { tone: "stop" as const, title: "This request would be blocked", body: "Fix the items marked below first. You can still send it; it will be recorded as blocked with the reason." };

  const canSend = !!startAt && !!endAt && purpose.trim().length >= 10 && courseOk && (!r.deposit_note || ack);

  return (
    <Page>
      <PageHeader title={`Book ${r.name}`} intro={r.location} back={() => router.back()} />
      <Columns>
        <Col flex={3}>
          <Section title="Day">
            <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
              {dates.map((d) => <Chip key={d} label={d === istDate(new Date()) ? "Today" : day(`${d}T12:00:00+05:30`)} selected={d === date} onPress={() => setDate(d)} />)}
            </View>
          </Section>

          <Section title="Length">
            <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
              {durations.map((m) => <Chip key={m} label={m >= 1440 ? `${m / 1440} day${m > 1440 ? "s" : ""}` : hours(m)} selected={m === duration} onPress={() => setDuration(m)} />)}
            </View>
          </Section>

          <Section title="Start time" hint={window ? "Struck-through times are already booked; choosing one puts you on the waitlist." : undefined}>
            {!window ? <Body style={{ color: p.ink3 }}>Closed on this day. Pick another day.</Body> : starts.length === 0 ? (
              <Body style={{ color: p.ink3 }}>No start times left today. Pick another day.</Body>
            ) : (
              <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                {starts.map((m) => {
                  const t = taken(m);
                  const isNow = isToday && m === nowFloor;
                  return <Chip key={m} label={isNow ? `Now (${hhmm(m)})` : t ? `${hhmm(m)} taken` : hhmm(m)} icon={t ? "clock" : undefined} selected={m === start} onPress={() => setStart(m)} />;
                })}
              </View>
            )}
          </Section>

          {r.quantity > 1 ? (
            <Section title="How many">
              <View style={{ flexDirection: "row", gap: space(3), alignItems: "center" }}>
                <Button small kind="secondary" label="Fewer" icon="minus" disabled={qty <= 1} onPress={() => setQty(qty - 1)} />
                <H3 style={{ minWidth: 40, textAlign: "center" }} >{qty}</H3>
                <Button small kind="secondary" label="More" icon="plus" disabled={qty >= r.quantity} onPress={() => setQty(qty + 1)} />
                <Small>of {r.quantity}</Small>
              </View>
            </Section>
          ) : null}

          <Section title="What it's for">
            <Field label="Purpose" value={purpose} onChangeText={setPurpose} multiline maxLength={600}
              hint={purpose.trim().length < 10 ? "At least 10 characters. The owner reads this." : `${purpose.length}/600`} />
            <Field label="Course code (optional)" value={course} onChangeText={setCourse} autoCapitalize="characters" maxLength={9}
              placeholder="ECE-304" error={courseOk ? null : "Use a code like ECE-304"} hint="Only registered courses count. Course-linked requests get priority when slots clash." />
            {(courses.data ?? []).length ? (
              <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                {(courses.data ?? []).map((c) => <Chip key={c.code} label={`${c.code} ${c.name}`} selected={course.trim().toUpperCase() === c.code} onPress={() => setCourse(course.trim().toUpperCase() === c.code ? "" : c.code)} />)}
              </View>
            ) : null}
            {r.deposit_note ? <Toggle label="I accept the deposit and charges" hint={r.deposit_note} value={ack} onChange={setAck} /> : null}
          </Section>
        </Col>

        <Col flex={2}>
          <Panel>
            <H3>{startAt && endAt ? `${day(startAt)}, ${hhmm(start!)}–${hhmm((start! + (duration ?? 0)) % 1440)}${duration && start! + duration >= 1440 ? " (+" + Math.floor((start! + duration) / 1440) + "d)" : ""}` : "Pick a day, length and start time"}</H3>
            {preview.isFetching && !pv ? <Loading label="Running checks" /> : null}
            <ErrorNote error={preview.error} />
            {outcomeText ? (
              <Panel tone={outcomeText.tone} style={{ padding: space(3) }}>
                <H3>{outcomeText.title}</H3>
                <Small>{outcomeText.body}</Small>
              </Panel>
            ) : null}
            {pv ? <CheckList checks={pv.checks} /> : null}
          </Panel>
          <ErrorNote error={submit.error} />
          <Button label={pv?.outcome === "blocked" ? "Send anyway (will be blocked)" : pv?.outcome === "waitlisted" ? "Join the waitlist" : "Send request"}
            kind={pv?.outcome === "blocked" ? "secondary" : "primary"} icon="send" disabled={!canSend} loading={submit.isPending} onPress={() => submit.mutate()} />
          {!canSend ? <Small>{!startAt ? "Choose a start time." : purpose.trim().length < 10 ? "Describe the purpose." : r.deposit_note && !ack ? "Accept the deposit terms." : !courseOk ? "Fix the course code." : ""}</Small> : null}
        </Col>
      </Columns>
    </Page>
  );
}
