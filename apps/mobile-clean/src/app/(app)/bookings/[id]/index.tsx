/**
 * One booking, as both parties see it: where it stands, what to do next, the
 * condition records side by side, any incidents, and the signed register.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { CheckList, CompetitionNote, KeyValue, SignedImage } from "@/components/domain";
import {
  Badge, Body, Button, CheckRow, Col, Columns, ErrorNote, H2, H3, Ledger, Loading, Page, PageHeader, Panel, ReasonDialog, Section, Small,
  StatusTag, Toggle, useToast,
} from "@/components/ui";
import { engine, engineConfigured, rpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ago, full, range } from "@/lib/format";
import { STATUS, actionLabel, roleLabel } from "@/lib/status";
import { space, usePalette } from "@/lib/theme";

type Dialog = null | "approve" | "reject" | "waitlist" | "cancel" | "confirm";

export default function BookingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const p = usePalette();
  const { profile, isManager } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [override, setOverride] = useState(false);

  const q = useQuery({ queryKey: ["booking", id], queryFn: () => rpc<any>("get_booking", { p_id: id }), enabled: !!id });
  const brief = useMutation({
    mutationFn: () => engine(`/ai/brief/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["booking", id] }),
  });

  if (q.isLoading) return <Page><Loading /></Page>;
  if (q.error || !q.data) return <Page><PageHeader title="Booking" back={() => router.back()} /><ErrorNote error={q.error ?? new Error("Booking not found")} retry={() => q.refetch()} /></Page>;
  const b = q.data;
  const can = b.can ?? {};
  const mine = b.user?.id === profile?.id;
  const st = STATUS[b.status];
  const checkin = (b.records as any[]).find((r) => r.phase === "checkin");
  const ret = (b.records as any[]).find((r) => r.phase === "return");

  const done = async (fn: string, args: Record<string, unknown>, msg: string) => {
    await rpc(fn, args);
    setDialog(null);
    setOverride(false);
    toast(msg);
    qc.invalidateQueries();
  };

  const blockedChecks = (b.checks ?? []).filter((c: any) => !c.ok);

  return (
    <Page onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <PageHeader title={b.resource.name} back={() => router.back()} intro={`${range(b.start, b.end)}, ${b.resource.location}`}
        right={<StatusTag status={b.status} large />} />

      <Columns>
        <Col flex={3}>
          {/* Where it stands, and the reason */}
          <Panel tone={st?.tone === "neutral" ? undefined : st?.tone}>
            <H3>{st?.label ?? b.status}: {st?.help}</H3>
            {b.decision_reason ? <Body style={{ fontSize: 15 }}>{b.decision_reason}</Body> : null}
            {b.override ? <Badge label="Approved with a manager override" tone="caution" /> : null}
            {b.decided_by ? <Small>Decided by {b.decided_by.full_name}{b.decided_at ? `, ${ago(b.decided_at)}` : ""}</Small> : null}
          </Panel>

          {b.competition ? <CompetitionNote c={b.competition} /> : null}

          {/* Next actions */}
          <View style={{ flexDirection: "row", gap: space(3), flexWrap: "wrap" }}>
            {can.check_in ? <Button icon="log-in" label="Check in" onPress={() => router.push(`/bookings/${id}/record?phase=checkin`)} /> : null}
            {mine && b.status === "approved" && !can.check_in ? <Small>Check-in opens 30 minutes before the start.</Small> : null}
            {can.return ? <Button icon="log-out" label="Return it" onPress={() => router.push(`/bookings/${id}/record?phase=return`)} /> : null}
            {can.confirm_return ? <Button icon="check-circle" label="Confirm return" onPress={() => setDialog("confirm")} /> : null}
            {can.decide ? (
              <>
                <Button icon="check" label="Approve" onPress={() => setDialog("approve")} />
                {b.status === "pending_review" ? <Button kind="secondary" icon="clock" label="Waitlist" onPress={() => setDialog("waitlist")} /> : null}
                <Button kind="danger" icon="x" label="Reject" onPress={() => setDialog("reject")} />
              </>
            ) : null}
            {can.report_incident ? <Button kind="secondary" icon="alert-triangle" label="Report a problem" onPress={() => router.push(`/bookings/${id}/incident`)} /> : null}
            {can.cancel ? <Button kind="ghost" icon="slash" label="Cancel booking" onPress={() => setDialog("cancel")} /> : null}
          </View>

          {/* Condition records, before and after */}
          {(checkin || ret) ? (
            <Section title="Condition record" hint="Recorded by the person using it, countersigned by the owner at the end.">
              <Columns gap={4}>
                {[checkin, ret].map((rec, i) => (
                  <Col key={i}>
                    <Panel>
                      <H3>{i === 0 ? "At check-in" : "At return"}</H3>
                      {rec ? (
                        <>
                          <Small>{full(rec.recorded_at)} by {rec.recorded_by_card?.full_name}</Small>
                          <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                            {(rec.photo_paths as string[]).map((ph) => <SignedImage key={ph} bucket="condition-photos" path={ph} size={104} />)}
                          </View>
                          {(Array.isArray(rec.checklist) ? rec.checklist : [])
                            .filter((c: any) => c && typeof c === "object" && typeof c.label === "string")
                            .map((c: any, k: number) => <CheckRow key={`${c.key}-${k}`} ok={c.ok === true} label={c.label} detail={typeof c.note === "string" && c.note ? c.note : undefined} />)}
                          {rec.notes ? <Small style={{ fontStyle: "italic" }}>“{rec.notes}”</Small> : null}
                          {rec.countersigned_at ? <Badge label="Countersigned" tone="go" /> : null}
                        </>
                      ) : <Small>Not recorded yet.</Small>}
                    </Panel>
                  </Col>
                ))}
              </Columns>
            </Section>
          ) : null}

          {(b.incidents as any[]).length ? (
            <Section title="Incidents">
              {(b.incidents as any[]).map((inc) => (
                <Panel key={inc.id} tone={inc.status === "resolved" ? undefined : "stop"}>
                  <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap", alignItems: "center" }}>
                    <H3>{inc.type[0].toUpperCase() + inc.type.slice(1)}, {inc.severity} severity</H3>
                    <Badge label={inc.status.replace("_", " ")} tone={inc.status === "resolved" ? "go" : "stop"} />
                  </View>
                  <Body style={{ fontSize: 15 }}>{inc.description}</Body>
                  <Small>Reported by {inc.reported_by_card?.full_name ?? "the system"}, {ago(inc.created_at)}{inc.estimated_cost ? `. Estimated cost ₹${inc.estimated_cost}` : ""}</Small>
                  {(inc.photo_paths as string[]).length ? (
                    <View style={{ flexDirection: "row", gap: space(2), flexWrap: "wrap" }}>
                      {(inc.photo_paths as string[]).map((ph) => <SignedImage key={ph} bucket="incident-photos" path={ph} size={88} />)}
                    </View>
                  ) : null}
                  {inc.resolution ? <Small style={{ color: p.ink }}>Resolution by {inc.resolved_by_card?.full_name}: {inc.resolution}{inc.strike_applied ? " (strike recorded)" : ""}</Small> : null}
                  {inc.status !== "resolved" ? <Button small kind="secondary" label="Open in Incidents" onPress={() => router.push("/incidents")} /> : null}
                </Panel>
              ))}
            </Section>
          ) : null}

          <Section title="Register" hint="Every change to this booking: who, when and why. Both sides see the same record.">
            <Panel>
              <Ledger fmt={full} entries={(b.history as any[]).map((h) => ({
                at: h.at, title: actionLabel(h.action), to: h.to, reason: h.reason,
                who: h.actor?.full_name ?? "System", role: h.actor_role ? roleLabel(h.actor_role) : null,
              }))} />
            </Panel>
          </Section>
        </Col>

        <Col flex={2}>
          <Panel>
            <H3>Request</H3>
            <KeyValue k="Requested by" v={b.user ? `${b.user.full_name}${b.user.department ? `, ${b.user.department}` : ""}${b.user.year_of_study ? ` year ${b.user.year_of_study}` : ""}` : null} />
            <KeyValue k="Purpose" v={b.purpose} />
            <KeyValue k="Course" v={b.course_code} />
            <KeyValue k="Quantity" v={b.quantity > 1 ? b.quantity : null} />
            <KeyValue k="Deposit terms" v={b.deposit_acknowledged ? "Accepted" : null} />
            <KeyValue k="Owner" v={b.owner?.full_name} />
            <KeyValue k="Requested" v={full(b.created_at)} />
            <Button small kind="ghost" label="View the resource" icon="external-link" onPress={() => router.push(`/resources/${b.resource.id}`)} />
          </Panel>

          {can.manage && b.ai_brief !== undefined && ["pending_review", "waitlisted", "blocked"].includes(b.status) ? (
            <Panel>
              <H3>Reviewer brief</H3>
              {b.ai_brief ? (
                <>
                  <Body style={{ fontSize: 15 }}>{b.ai_brief.summary}</Body>
                  {(b.ai_brief.flags ?? []).map((f: string) => <Small key={f}>{f}</Small>)}
                  <Small style={{ color: p.ink3 }}>{b.ai_brief.source === "gemini" ? "Written by AI from the facts above. Advisory only: you decide." : "Built from rules (AI not configured). Advisory only."}</Small>
                </>
              ) : <Small>A short summary of this request and anything worth checking.</Small>}
              <ErrorNote error={brief.error} />
              {engineConfigured ? <Button small kind="secondary" icon="file-text" label={b.ai_brief ? "Refresh brief" : "Write brief"} loading={brief.isPending} onPress={() => brief.mutate()} /> : null}
            </Panel>
          ) : null}

          {b.checks ? (
            <Panel>
              <H3>Automatic checks at request time</H3>
              <CheckList checks={b.checks} />
            </Panel>
          ) : null}
        </Col>
      </Columns>

      <ReasonDialog visible={dialog === "approve"} title="Approve this request" confirmLabel="Approve" initial="Meets the requirements; slot is free"
        body={b.status === "blocked" ? "This request failed automatic checks. Only a department manager can approve it, with an override." : undefined}
        extra={b.status === "blocked" && isManager ? (
          <View style={{ gap: space(2) }}>
            {blockedChecks.map((c: any) => <CheckRow key={c.key} ok={false} label={c.label} detail={c.detail} />)}
            <Toggle label="Override the failed checks" hint="Recorded in the register as a manager override." value={override} onChange={setOverride} />
          </View>
        ) : undefined}
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => done("decide_booking", { p_booking: id, p_decision: "approve", p_reason: reason, p_override: override }, "Approved")} />
      <ReasonDialog visible={dialog === "reject"} title="Reject this request" danger confirmLabel="Reject" body="The student sees this reason."
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => done("decide_booking", { p_booking: id, p_decision: "reject", p_reason: reason, p_override: false }, "Rejected")} />
      <ReasonDialog visible={dialog === "waitlist"} title="Move to the waitlist" confirmLabel="Waitlist" body="It moves back to review automatically when the slot frees."
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => done("decide_booking", { p_booking: id, p_decision: "waitlist", p_reason: reason, p_override: false }, "Moved to the waitlist")} />
      <ReasonDialog visible={dialog === "cancel"} title="Cancel this booking" danger confirmLabel="Cancel booking" minLength={mine ? 0 : 5}
        initial={mine ? "Plans changed" : ""} body={mine ? "The owner is told. If the slot was approved, the next person on the waitlist moves up." : "The student sees this reason."}
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => done("cancel_booking", { p_booking: id, p_reason: reason }, "Booking cancelled")} />
      <ReasonDialog visible={dialog === "confirm"} title="Confirm the return" confirmLabel="Confirm and close" minLength={0}
        initial="Condition matches the return record"
        body="Compare the check-in and return photos first. If something is wrong, cancel and report a problem instead."
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => done("confirm_return", { p_booking: id, p_note: reason }, "Return confirmed, booking closed")} />
    </Page>
  );
}
