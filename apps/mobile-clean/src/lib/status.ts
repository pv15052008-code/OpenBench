/** How each booking state is named and coloured everywhere in the app. */
import type { Palette } from "./theme";

export type Tone = "go" | "caution" | "stop" | "brand" | "neutral";

export const STATUS: Record<string, { label: string; tone: Tone; help: string }> = {
  requested: { label: "Requested", tone: "neutral", help: "Sent, being checked" },
  blocked: { label: "Blocked", tone: "stop", help: "An automatic check failed" },
  pending_review: { label: "In review", tone: "caution", help: "Waiting for the owner" },
  waitlisted: { label: "Waitlisted", tone: "caution", help: "Moves up if the slot frees" },
  approved: { label: "Approved", tone: "go", help: "Check in when the slot starts" },
  rejected: { label: "Not approved", tone: "stop", help: "See the reason" },
  cancelled: { label: "Cancelled", tone: "neutral", help: "No longer active" },
  checked_in: { label: "In use", tone: "brand", help: "Return before the slot ends" },
  returned: { label: "Returned", tone: "brand", help: "Owner is confirming the condition" },
  closed: { label: "Closed", tone: "neutral", help: "Complete" },
  disputed: { label: "Disputed", tone: "stop", help: "An incident is open" },
  no_show: { label: "No-show", tone: "stop", help: "Not checked in on time" },
  overdue: { label: "Overdue", tone: "stop", help: "Return time has passed" },
};

export function toneColors(p: Palette, tone: Tone) {
  switch (tone) {
    case "go": return { fg: p.go, bg: p.goSoft, bar: p.go };
    case "caution": return { fg: p.caution, bg: p.cautionSoft, bar: p.cautionStrong };
    case "stop": return { fg: p.stop, bg: p.stopSoft, bar: p.stop };
    case "brand": return { fg: p.brand, bg: p.brandSoft, bar: p.brand };
    default: return { fg: p.ink2, bg: p.sunken, bar: p.ruleStrong };
  }
}

export const ACTION_LABEL: Record<string, string> = {
  request_submitted: "Request submitted",
  approved: "Approved",
  override_approved: "Approved with manager override",
  rejected: "Not approved",
  waitlisted: "Moved to waitlist",
  waitlisted_by_allocation: "Moved to waitlist by fair allocation",
  waitlist_promoted: "Promoted from waitlist",
  cancelled_by_user: "Cancelled by requester",
  cancelled_by_owner: "Cancelled by owner",
  checked_in: "Checked in, condition recorded",
  returned: "Returned, condition recorded",
  returned_late: "Returned late, condition recorded",
  return_confirmed: "Return confirmed by owner",
  incident_opened: "Incident opened",
  incident_reported: "Incident reported",
  incident_under_review: "Incident under review",
  incident_resolved: "Incident resolved",
  dispute_closed: "Dispute closed",
  no_show: "Marked no-show",
  overdue: "Marked overdue",
  status_change: "Status changed",
  resource_listed: "Resource listed",
  resource_status: "Resource status changed",
  resource_updated: "Resource updated",
  resource_rules_changed: "Rules changed",
  qualification_submitted: "Certificate submitted",
  qualification_verified: "Training verified",
  qualification_rejected: "Certificate rejected",
  qualification_pending: "Certificate resubmitted",
  profile_standing: "Account standing changed",
  profile_verified: "Account verified",
  profile_rejected: "Account rejected",
  role_changed: "Role changed",
  strike_applied: "Strike recorded",
  strikes_cleared: "Strikes cleared",
};

export const actionLabel = (a: string) => ACTION_LABEL[a] ?? a.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const roleLabel = (r: string) =>
  ({ user: "Student", owner: "Resource owner", manager: "Department manager", admin: "Administrator" } as Record<string, string>)[r] ?? r;
