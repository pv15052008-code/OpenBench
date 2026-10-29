"""
Database tests for OpenBench.

Each test resets a local Postgres (with a small Supabase shim) and talks to it
exactly the way the app does: as the `authenticated` role with a user id in the
JWT claim. That means Row Level Security, grants and triggers are all live.

Run:  python -m pytest supabase/tests -q
"""
import json
import os
import subprocess
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

HERE = os.path.dirname(__file__)
DSN = os.environ.get("TEST_DSN", "host=127.0.0.1 dbname=openbench_fix user=postgres password=postgres")


@pytest.fixture(autouse=True)
def fresh_db():
    subprocess.run([os.path.join(HERE, "reset_local.sh")], check=True, env={**os.environ, "SEED": "1"},
                   stdout=subprocess.DEVNULL)


def uid(email: str) -> str:
    with psycopg.connect(DSN) as c:
        return str(c.execute("select id from profiles where email = %s", (email,)).fetchone()[0])


@contextmanager
def as_user(email: str | None, role: str = "authenticated"):
    """A connection that behaves like a supabase-js client signed in as `email`."""
    conn = psycopg.connect(DSN, autocommit=False)
    user_id = uid(email) if email else ""
    conn.execute(f"set role {role}")
    conn.execute("select set_config('request.jwt.claim.sub', %s, false)", (user_id,))
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def rpc(email, fn, *args):
    """Call an RPC as a user; returns the parsed result."""
    placeholders = ", ".join(["%s"] * len(args))
    with as_user(email) as c:
        row = c.execute(f"select {fn}({placeholders})", args).fetchone()
        return row[0]


def rpc_fails(email, fn, *args, match=""):
    with pytest.raises(psycopg.Error) as e:
        rpc(email, fn, *args)
    assert match.lower() in str(e.value).lower(), str(e.value)
    return str(e.value)


def admin_sql(sql, *args):
    with psycopg.connect(DSN, autocommit=True) as c:
        cur = c.execute(sql, args)
        return cur.fetchall() if cur.description else None


def resource_id(name):
    return str(admin_sql("select id from resources where name = %s", name)[0][0])


def now_slot(minutes=60, offset_minutes=0):
    start = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start = start - timedelta(minutes=start.minute % 15) + timedelta(minutes=offset_minutes)
    return start, start + timedelta(minutes=minutes)


def ist_slot(day_offset, hour, minutes):
    """A slot at a given IST hour, `day_offset` days from today, avoiding Sundays."""
    ist = timezone(timedelta(hours=5, minutes=30))
    d = datetime.now(ist).replace(hour=hour, minute=0, second=0, microsecond=0) + timedelta(days=day_offset)
    while d.weekday() == 6:
        d += timedelta(days=1)
    return d, d + timedelta(minutes=minutes)


AARAV, ISHA, KABIR, RIYA = "aarav@demo.openbench.in", "isha@demo.openbench.in", "kabir@demo.openbench.in", "newstudent@demo.openbench.in"
MEHTA, RAO, KAPOOR, HOD, ADMIN = ("prof.mehta@demo.openbench.in", "dr.rao@demo.openbench.in", "ms.kapoor@demo.openbench.in",
                                  "hod.sharma@demo.openbench.in", "admin@demo.openbench.in")
CHECK = json.dumps([{"key": "bed", "label": "Print bed clean", "ok": True}])


def answers(booking_id, ok=True):
    """A complete checklist answer for a booking, built from its resource's template."""
    tpl = admin_sql("select r.checklist_template from bookings b join resources r on r.id=b.resource_id where b.id=%s", booking_id)[0][0]
    return json.dumps([{"key": t["key"], "ok": ok, "note": "" if ok else "Not right"} for t in tpl])


def photo(bucket, path):
    """Register an uploaded file, as Supabase Storage would after a successful upload."""
    admin_sql("insert into storage.objects (bucket_id, name) values (%s, %s)", bucket, path)
    return path


# ---------------------------------------------------------------------------
# The judge journey, end to end
# ---------------------------------------------------------------------------

def test_full_journey_listing_to_closed_record():
    printer = resource_id("Prusa MK4 3D Printer")
    start, end = ist_slot(2, 10, 60)

    # 1. Aarav has no 3D printing training: the request is blocked with a reason
    preview = rpc(AARAV, "preview_booking", printer, start, end, 1, None)
    assert preview["outcome"] == "blocked"
    failed = [c for c in preview["checks"] if not c["ok"]]
    assert any("3D printing" in c["label"] for c in failed)
    blocked = rpc(AARAV, "request_booking", printer, start, end, 1, "Printing a robot chassis for the robotics club", None, True)
    assert blocked["status"] == "blocked"
    ns, ne = now_slot(60)
    blocked_now = rpc(AARAV, "request_booking", printer, ns, ne, 1, "Printing a robot chassis for the robotics club", None, True)
    assert blocked_now["status"] == "blocked"

    # 2. He uploads a certificate; even if he tries to mark it verified, it stays pending
    aarav = uid(AARAV)
    with as_user(AARAV) as c:
        c.execute("insert into user_qualifications (user_id, training_tag, evidence_path, status) values (%s, '3d_printing', %s, 'verified')",
                  (aarav, f"{aarav}/cert.png"))
        status = c.execute("select status from user_qualifications where user_id = %s and training_tag = '3d_printing'", (aarav,)).fetchone()[0]
    assert status == "pending"

    # 3. The printer owner sees it in the verification queue and verifies it
    q = rpc(MEHTA, "verification_queue")
    qual = next(x for x in q["qualifications"] if x["training_tag"] == "3d_printing")
    rpc(MEHTA, "verify_qualification", qual["id"], "verified", "Induction attendance confirmed", None)

    # 4. Now he can request a slot starting now; an earlier blocked request for the same time doesn't get in the way
    s, e = now_slot(60)
    req = rpc(AARAV, "request_booking", printer, s, e, 1, "Printing a robot chassis for the robotics club", None, True)
    assert req["status"] == "pending_review", req
    assert admin_sql("select status from bookings where id=%s", blocked_now["id"])[0][0] == "cancelled"

    # 5. Owner reviews and approves with a reason
    queue = rpc(MEHTA, "review_queue")
    assert any(r["id"] == req["id"] for r in queue["requests"])
    rpc(MEHTA, "decide_booking", req["id"], "approve", "Training verified, slot free", False)

    # 6. Check-in with checklist and a photo in his own folder
    rpc(AARAV, "check_in", req["id"], answers(req["id"]), [photo("condition-photos", f"{req['id']}/{aarav}/in.jpg")], "Bed clean")
    # 7. Return
    rpc(AARAV, "return_booking", req["id"], answers(req["id"]), [photo("condition-photos", f"{req['id']}/{aarav}/out.jpg")], "Printed 80 g PLA")
    # 8. Owner confirms the condition; booking closes and both records are countersigned
    rpc(MEHTA, "confirm_return", req["id"], None)

    detail = rpc(AARAV, "get_booking", req["id"])
    assert detail["status"] == "closed"
    assert len(detail["records"]) == 2 and all(r["countersigned_by"] for r in detail["records"])
    actions = [h["action"] for h in detail["history"]]
    assert actions == ["request_submitted", "approved", "checked_in", "returned", "return_confirmed"], actions
    # Both parties see the same history
    assert rpc(MEHTA, "get_booking", req["id"])["history"] == detail["history"]
    # Notifications reached the student
    with as_user(AARAV) as c:
        titles = [r[0] for r in c.execute("select title from notifications order by created_at").fetchall()]
    assert any(t.startswith("Approved") for t in titles) and any(t.startswith("Booking closed") for t in titles)


# ---------------------------------------------------------------------------
# Fair allocation
# ---------------------------------------------------------------------------

def test_competing_requests_ranked_and_waitlist_promoted():
    queue = rpc(MEHTA, "review_queue")["requests"]
    printer_reqs = [r for r in queue if r["resource"]["name"] == "Prusa MK4 3D Printer" and r["status"] == "pending_review"]
    assert len(printer_reqs) == 2
    by_user = {r["user"]["full_name"]: r for r in printer_reqs}
    kabir, isha = by_user["Kabir Nair"], by_user["Isha Verma"]
    # Kabir is a first-time user with no hours this week: rank 1 although he asked later
    assert kabir["competition"]["rank"] == 1 and isha["competition"]["rank"] == 2
    assert "First use" in kabir["competition"]["reasons"][0]

    # Approving Kabir moves Isha to the waitlist with an explanation, not a rejection
    res = rpc(MEHTA, "decide_booking", kabir["id"], "approve", "First-time user has priority", False)
    assert res["moved_to_waitlist"] == 1
    isha_now = rpc(ISHA, "get_booking", isha["id"])
    assert isha_now["status"] == "waitlisted" and "fair-allocation" in isha_now["decision_reason"]
    assert "queue" not in (isha_now["competition"] or {}), "students must not see other students' booking ids"

    # Kabir cancels: Isha is promoted back to review automatically
    out = rpc(KABIR, "cancel_booking", kabir["id"], "Project timeline moved")
    assert out["promoted_from_waitlist"] == 1
    assert rpc(ISHA, "get_booking", isha["id"])["status"] == "pending_review"


def test_weekly_cap_blocks_and_explains():
    printer = resource_id("Prusa MK4 3D Printer")
    # Put 5 h of approved printer time in the same IST week as the requested slot (cap is 6 h)
    start, end = ist_slot(1, 9, 120)
    week_start = admin_sql("select ws from _week_bounds(%s)", start)[0][0]
    admin_sql("""insert into bookings (resource_id, user_id, during, purpose, status)
                 values (%s, (select id from profiles where email=%s), tstzrange(%s::timestamptz + interval '1 hour', %s::timestamptz + interval '6 hours'),
                         'Earlier long print this week', 'closed')""", printer, KABIR, week_start, week_start)
    preview = rpc(KABIR, "preview_booking", printer, start, end, 1, None)
    checks = {c["key"]: c for c in preview["checks"]}
    # 5 h closed + his pending 2 h request tomorrow = 7 h, plus 2 h requested > 6 h cap
    assert checks["weekly_minutes"]["ok"] is False and "7.0 h used" in checks["weekly_minutes"]["detail"]
    assert preview["outcome"] == "blocked"
    r = rpc(KABIR, "request_booking", printer, start, end, 1, "Another long print this week", None, True)
    assert r["status"] == "blocked"
    assert "hours of this resource per week" in admin_sql("select decision_reason from bookings where id=%s", r["id"])[0][0]
    # A manager can still approve it, but only with an explicit override that is logged
    rpc_fails(MEHTA, "decide_booking", r["id"], "approve", "Owner wants to allow", False, match="requirements are not met")
    rpc_fails(MEHTA, "decide_booking", r["id"], "approve", "Owner tries override", True, match="requirements are not met")
    rpc(HOD, "decide_booking", r["id"], "approve", "Exam-week exception approved by HOD", True)
    hist = rpc(KABIR, "get_booking", r["id"])["history"]
    assert hist[-1]["action"] == "override_approved" and hist[-1]["reason"].startswith("Exam-week")


def test_double_booking_impossible_even_for_managers():
    scope = resource_id("Keysight DSOX1204G Oscilloscope")
    start, end = ist_slot(3, 11, 60)
    with psycopg.connect(DSN) as c:
        c.execute("update user_qualifications set status='verified' where training_tag='electronics_lab'")
        c.execute("insert into user_qualifications (user_id, training_tag, evidence_path, status) values (%s, 'electronics_lab', %s, 'verified')",
                  (uid(KABIR), f"{uid(KABIR)}/e.png"))
        c.commit()
    a = rpc(AARAV, "request_booking", scope, start, end, 1, "Ripple measurement for lab report", None, False)
    b = rpc(KABIR, "request_booking", scope, start, end, 1, "Testing the sensor node waveform", None, False)
    assert a["status"] == b["status"] == "pending_review"
    rpc(RAO, "decide_booking", a["id"], "approve", "Course work first", False)
    # The second request was moved to the waitlist; approving it now must fail
    assert rpc(KABIR, "get_booking", b["id"])["status"] == "waitlisted"
    rpc_fails(RAO, "decide_booking", b["id"], "approve", "Trying anyway", False, match="no longer free")
    # And even a raw insert as the database owner hits the exclusion constraint
    with pytest.raises(psycopg.errors.ExclusionViolation):
        admin_sql("insert into bookings (resource_id, user_id, during, purpose, status) values (%s, %s, tstzrange(%s, %s), 'raw insert attempt', 'approved')",
                  scope, uid(KABIR), start, end)


def test_pooled_capacity():
    kits = resource_id("Arduino Uno Starter Kit")
    start, end = ist_slot(2, 9, 240)
    # Kabir has 2 kits out for 4 days covering this slot: 8 left
    r = rpc(AARAV, "request_booking", kits, start, end, 8, "Workshop for first-year students", None, True)
    assert r["status"] == "pending_review"
    rpc(RAO, "decide_booking", r["id"], "approve", "Workshop approved", False)
    r2 = rpc(ISHA, "request_booking", kits, start, end, 1, "Line follower robot practice", None, True)
    assert r2["status"] == "waitlisted"


def test_deposit_acknowledgement_required():
    kits = resource_id("Arduino Uno Starter Kit")
    start, end = ist_slot(2, 9, 240)
    rpc_fails(AARAV, "request_booking", kits, start, end, 1, "Workshop for first-year students", None, False, match="deposit")


# ---------------------------------------------------------------------------
# Incidents, disputes and strikes stay with humans
# ---------------------------------------------------------------------------

def test_incident_dispute_resolution_requires_manager():
    camera_booking = admin_sql("select b.id from bookings b join resources r on r.id=b.resource_id where r.name like 'Sony%%' and b.status='returned'")[0][0]
    camera_booking = str(camera_booking)
    kapoor = uid(KAPOOR)
    res = rpc(KAPOOR, "report_incident", camera_booking, "damage", "medium",
              "Small scratch on the lens hood that was not in the check-in photos", [photo("incident-photos", f"{camera_booking}/{kapoor}/scratch.jpg")], 300)
    assert res["booking_status"] == "disputed"
    incident_id = res["id"]
    # The owner is not a manager of CSE: cannot resolve alone
    rpc_fails(KAPOOR, "resolve_incident", incident_id, "Owner tries to resolve", True, match="not found")
    # The student cannot resolve either
    rpc_fails(KABIR, "resolve_incident", incident_id, "I resolve my own dispute", False, match="not found")
    # Confirm return is refused while the dispute is open
    rpc_fails(KAPOOR, "confirm_return", camera_booking, None, match="")
    # Admin resolves, applies a strike with a reason
    out = rpc(ADMIN, "resolve_incident", incident_id, "Scratch confirmed from photos; cosmetic only, no charge", True)
    assert out["booking_status"] == "closed"
    assert admin_sql("select strikes from profiles where email = %s", KABIR)[0][0] == 1
    actions = [h["action"] for h in rpc(KABIR, "get_booking", camera_booking)["history"]]
    for a in ["incident_opened", "incident_reported", "incident_resolved", "dispute_closed"]:
        assert a in actions, actions


def test_sweep_marks_no_show_and_overdue_without_striking():
    scope_booking = str(admin_sql("select b.id from bookings b join resources r on r.id=b.resource_id where r.name like 'Keysight%%' and b.status='approved'")[0][0])
    admin_sql("update bookings set during = tstzrange(now() - interval '3 hours', now() - interval '1 hour') where id = %s", scope_booking)
    kits_booking = str(admin_sql("select b.id from bookings b join resources r on r.id=b.resource_id where r.name like 'Arduino%%' and b.status='checked_in'")[0][0])
    admin_sql("update bookings set during = tstzrange(now() - interval '3 days', now() - interval '1 hour') where id = %s", kits_booking)
    out = rpc(AARAV, "sweep_due")
    assert out == {**out, "no_show": 1, "overdue": 1}
    assert admin_sql("select status from bookings where id = %s", scope_booking)[0][0] == "no_show"
    assert admin_sql("select status from bookings where id = %s", kits_booking)[0][0] == "overdue"
    # Incidents opened for a human; strikes unchanged
    assert admin_sql("select count(*) from incidents where booking_id in (%s, %s) and status = 'open'", scope_booking, kits_booking)[0][0] == 2
    assert admin_sql("select strikes from profiles where email = %s", AARAV)[0][0] == 0
    # Idempotent
    assert rpc(AARAV, "sweep_due")["no_show"] == 0


# ---------------------------------------------------------------------------
# Security: what a curious or malicious student will try
# ---------------------------------------------------------------------------

def test_student_cannot_write_bookings_directly():
    b = str(admin_sql("select id from bookings where user_id = (select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(AARAV) as c:
            c.execute("update bookings set status = 'closed' where id = %s", (b,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(AARAV) as c:
            c.execute("insert into bookings (resource_id, user_id, during, purpose, status) select resource_id, user_id, during, 'sneaky insert here', 'approved' from bookings where id = %s", (b,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(AARAV) as c:
            c.execute("delete from bookings where id = %s", (b,))


def test_student_cannot_escalate_role_or_clear_strikes():
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(ISHA) as c:
            c.execute("update profiles set role = 'admin' where id = auth.uid()")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(ISHA) as c:
            c.execute("update profiles set strikes = 0, verification_status = 'verified' where id = auth.uid()")
    rpc_fails(ISHA, "set_user_role", uid(ISHA), "admin", None, "please", match="only an admin")
    rpc_fails(ISHA, "clear_strikes", uid(ISHA), "please clear", match="not found")
    # Allowed: editing her own name
    with as_user(ISHA) as c:
        c.execute("update profiles set full_name = 'Isha V.' where id = auth.uid()")
    # Editing another student's name silently affects nothing (RLS)
    with as_user(ISHA) as c:
        n = c.execute("update profiles set full_name = 'hacked' where email = %s", (KABIR,)).rowcount
    assert n == 0


def test_department_change_resets_verification():
    cse = admin_sql("select id from departments where code='CSE'")[0][0]
    with as_user(AARAV) as c:
        c.execute("update profiles set department_id = %s where id = auth.uid()", (cse,))
    assert admin_sql("select verification_status from profiles where email=%s", AARAV)[0][0] == "pending"


def test_students_cannot_see_each_other():
    with as_user(AARAV) as c:
        others = c.execute("select count(*) from bookings where user_id <> auth.uid()").fetchone()[0]
        profiles = c.execute("select count(*) from profiles where id <> auth.uid()").fetchone()[0]
        quals = c.execute("select count(*) from user_qualifications where user_id <> auth.uid()").fetchone()[0]
        notes = c.execute("select count(*) from notifications where user_id <> auth.uid()").fetchone()[0]
    assert (others, profiles, quals, notes) == (0, 0, 0, 0)
    isha_booking = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) limit 1", ISHA)[0][0])
    rpc_fails(AARAV, "get_booking", isha_booking, match="not found")


def test_audit_log_is_unreadable_and_immutable_for_clients():
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(ADMIN) as c:
            c.execute("select * from audit_log limit 1")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(ADMIN) as c:
            c.execute("delete from audit_log")
    feed = rpc(ADMIN, "audit_feed", None, 50, None)
    assert len(feed) > 0


def test_owner_scope_and_conflict_of_interest():
    # Prof. Mehta (ME) cannot decide ECE requests
    scope = resource_id("Keysight DSOX1204G Oscilloscope")
    start, end = ist_slot(3, 15, 60)
    r = rpc(AARAV, "request_booking", scope, start, end, 1, "Lab report measurements", None, False)
    rpc_fails(MEHTA, "decide_booking", r["id"], "approve", "Not my lab", False, match="not found")
    # A manager cannot approve their own request
    printer = resource_id("Prusa MK4 3D Printer")
    s2, e2 = ist_slot(4, 10, 60)
    own = rpc(HOD, "request_booking", printer, s2, e2, 1, "Testing the printer after maintenance", None, True)
    rpc_fails(HOD, "decide_booking", own["id"], "approve", "Self approval", False, match="own request")


def test_reason_required_for_decisions():
    queue = rpc(MEHTA, "review_queue")["requests"]
    rpc_fails(MEHTA, "decide_booking", queue[0]["id"], "reject", "", False, match="reason")


def test_photo_paths_must_belong_to_caller_and_booking():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    other = str(uuid.uuid4())
    rpc_fails(AARAV, "check_in", b, CHECK, [f"{other}/{uid(AARAV)}/x.jpg"], "", match="does not belong")
    rpc_fails(AARAV, "check_in", b, CHECK, [f"{b}/{uid(ISHA)}/x.jpg"], "", match="does not belong")
    rpc_fails(AARAV, "check_in", b, CHECK, [f"{b}/{uid(AARAV)}/../../etc/passwd"], "", match="does not belong")
    rpc_fails(AARAV, "check_in", b, CHECK, [], "", match="photo")


def test_someone_else_cannot_check_in_my_booking():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    rpc_fails(KABIR, "check_in", b, CHECK, [f"{b}/{uid(KABIR)}/x.jpg"], "", match="not found")
    rpc_fails(RAO, "check_in", b, CHECK, [f"{b}/{uid(RAO)}/x.jpg"], "", match="not found")


def test_illegal_transitions_refused():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    rpc_fails(AARAV, "return_booking", b, CHECK, [f"{b}/{uid(AARAV)}/x.jpg"], "", match="checked-in")
    rpc_fails(RAO, "confirm_return", b, None, match="returned")
    with pytest.raises(psycopg.Error, match="cannot move"):
        admin_sql("update bookings set status = 'closed' where id = %s", b)


def _res(**kw):
    base = {"kind": "equipment", "category": "Lathe", "name": "Mini lathe", "location": "B-204", "status": "active",
            "slot_minutes": 60, "max_minutes_per_booking": 120, "lead_time_hours": 0,
            "checklist_template": [{"key": "chuck", "label": "Chuck key returned"}],
            "requirements": [{"type": "training", "value": "3d_printing", "label": "3D printing safety induction"}],
            "availability": [{"weekday": 1, "opens_at": "09:00", "closes_at": "17:00"}],
            "policy": {"max_bookings_per_week": 2, "max_minutes_per_week": 240}}
    base.update(kw)
    return json.dumps(base)


def test_unverified_user_blocked_and_cannot_list():
    printer = resource_id("Prusa MK4 3D Printer")
    start, end = ist_slot(2, 12, 60)
    r = rpc(RIYA, "request_booking", printer, start, end, 1, "Want to try the printer", None, True)
    assert r["status"] == "blocked"
    rpc_fails(RIYA, "save_resource", _res(), match="verified owners")


def test_student_cannot_list_resources_or_write_tables():
    rpc_fails(AARAV, "save_resource", _res(), match="verified owners")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(AARAV) as c:
            dept = c.execute("select department_id from profiles where id = auth.uid()").fetchone()[0]
            c.execute("insert into resources (owner_id, department_id, kind, category, name, location) values (auth.uid(), %s, 'equipment', 'Test', 'Fake listing', 'Nowhere')", (dept,))


def test_owner_saves_resource_atomically_in_own_department():
    ece = admin_sql("select id from departments where code='ECE'")[0][0]
    rid = str(rpc(MEHTA, "save_resource", _res(department_id=str(ece))))
    # Department forced to the owner's own (ME), never ECE
    assert admin_sql("select d.code from resources r join departments d on d.id=r.department_id where r.id=%s", rid)[0][0] == "ME"
    assert admin_sql("select count(*) from resource_requirements where resource_id=%s", rid)[0][0] == 1
    assert admin_sql("select max_bookings_per_week from fairness_policies where resource_id=%s", rid)[0][0] == 2
    # Edit replaces child rows; a bad requirement rolls the whole save back
    rpc(MEHTA, "save_resource", _res(id=rid, requirements=[], name="Mini lathe (bench)"))
    assert admin_sql("select count(*) from resource_requirements where resource_id=%s", rid)[0][0] == 0
    rpc_fails(MEHTA, "save_resource", _res(id=rid, name="Should not stick", requirements=[{"type": "min_year", "value": "9", "label": "x"}]), match="1 to 6")
    assert admin_sql("select name from resources where id=%s", rid)[0][0] == "Mini lathe (bench)"
    # Foreign photo URLs are refused
    rpc_fails(MEHTA, "save_resource", _res(id=rid, photo_urls=["https://evil.example/x.jpg"]), match="through OpenBench")
    ok_url = f"http://localhost:54321/storage/v1/object/public/resource-photos/{uid(MEHTA)}/lathe.jpg"
    rpc(MEHTA, "save_resource", _res(id=rid, photo_urls=[ok_url]))


def test_owner_cannot_edit_other_owners_resource():
    scope = resource_id("Keysight DSOX1204G Oscilloscope")
    rpc_fails(MEHTA, "save_resource", _res(id=scope, name="Hijacked"), match="not found")
    # The ME manager cannot edit ECE either; the admin can
    rpc_fails(HOD, "save_resource", _res(id=scope, name="Hijacked"), match="not found")
    rpc(ADMIN, "save_resource", _res(id=scope, name="Keysight DSOX1204G Oscilloscope", department_id=str(admin_sql("select department_id from resources where id=%s", scope)[0][0])))


def test_cannot_verify_own_qualification_or_profile():
    kabir = uid(KABIR)
    q = admin_sql("select id from user_qualifications where user_id=%s and training_tag='drone_rules'", kabir)[0][0]
    rpc_fails(KABIR, "verify_qualification", str(q), "verified", "Self approve", None, match="not found")
    rpc_fails(ADMIN, "verify_profile", uid(ADMIN), "verified", "me", match="yourself")


def test_anon_has_no_access():
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(None, role="anon") as c:
            c.execute("select list_resources()")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(None, role="anon") as c:
            c.execute("select * from resources")


def test_internal_functions_not_callable():
    for fn in ["seed_demo()", "_set_context('x','y')", "_notify(auth.uid(),'x','title','b',null)",
               "_promote_waitlist(gen_random_uuid(), tstzrange(now(), now()+interval '1h'))"]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with as_user(AARAV) as c:
                c.execute(f"select {fn}")


def test_storage_policies():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    aarav = uid(AARAV)
    with as_user(AARAV) as c:
        c.execute("insert into storage.objects (bucket_id, name) values ('condition-photos', %s)", (f"{b}/{aarav}/ok.jpg",))
    for bad in [f"{b}/{uid(ISHA)}/x.jpg", f"{uuid.uuid4()}/{aarav}/x.jpg", f"not-a-uuid/{aarav}/x.jpg", f"{b}/{aarav}/deep/x.jpg"]:
        with pytest.raises(psycopg.Error):
            with as_user(AARAV) as c:
                c.execute("insert into storage.objects (bucket_id, name) values ('condition-photos', %s)", (bad,))
    # Isha cannot read Aarav's photo; the owner can
    with as_user(ISHA) as c:
        assert c.execute("select count(*) from storage.objects where bucket_id='condition-photos'").fetchone()[0] == 0
    with as_user(RAO) as c:
        assert c.execute("select count(*) from storage.objects where bucket_id='condition-photos'").fetchone()[0] == 1
    # Eligibility docs: own folder only
    with pytest.raises(psycopg.Error):
        with as_user(AARAV) as c:
            c.execute("insert into storage.objects (bucket_id, name) values ('eligibility-docs', %s)", (f"{uid(ISHA)}/fake.pdf",))
    # Students cannot upload resource photos
    with pytest.raises(psycopg.Error):
        with as_user(AARAV) as c:
            c.execute("insert into storage.objects (bucket_id, name) values ('resource-photos', %s)", (f"{aarav}/x.jpg",))


def test_rate_limit_on_requests():
    printer = resource_id("CO2 Laser Cutter 60 W")
    for i in range(10):
        s, e = ist_slot(5 + i, 10, 60)
        rpc(AARAV, "request_booking", printer, s, e, 1, f"Rate limit probe number {i}", None, True)
    s, e = ist_slot(16, 10, 60)
    rpc_fails(AARAV, "request_booking", printer, s, e, 1, "One request too many", None, True, match="too many")


def test_read_rpcs_work_for_every_role():
    for who in [AARAV, ISHA, KABIR, RIYA, MEHTA, RAO, KAPOOR, HOD, ADMIN]:
        assert isinstance(rpc(who, "list_resources", None, None, None, None, False, False), list)
        assert isinstance(rpc(who, "my_bookings"), list)
        assert isinstance(rpc(who, "review_queue"), dict)
        assert isinstance(rpc(who, "incident_feed"), list)
        assert isinstance(rpc(who, "audit_feed", None, 20, None), list)
        assert isinstance(rpc(who, "verification_queue"), dict)
        assert isinstance(rpc(who, "fairness_report"), list)
    res = rpc(AARAV, "list_resources", "printer", None, None, None, False, False)
    assert res and res[0]["name"].startswith("Prusa") and res[0]["eligible"] is False
    # Maintenance resources are hidden from students but visible to their owner
    names = [r["name"] for r in rpc(AARAV, "list_resources", None, None, None, None, False, False)]
    assert "Rigol DG1022Z Function Generator" not in names
    assert "Rigol DG1022Z Function Generator" in [r["name"] for r in rpc(RAO, "list_resources", None, None, None, None, False, True)]
    # Injection-looking search terms are harmless
    assert rpc(AARAV, "list_resources", "'; drop table bookings; --", None, None, None, False, False) == []
    detail = rpc(AARAV, "get_resource", resource_id("Prusa MK4 3D Printer"))
    assert detail["eligibility"] and all("mine" in b for b in detail["busy"])


def test_signup_domain_restriction():
    admin_sql("update app_settings set allowed_email_domains = '{campus.edu}'")
    with pytest.raises(psycopg.Error, match="institution email"):
        admin_sql("insert into auth.users (email) values ('outsider@gmail.com')")
    admin_sql("insert into auth.users (email) values ('student@campus.edu')")
    assert admin_sql("select role, verification_status from profiles where email='student@campus.edu'")[0] == ("user", "pending")


# ---------------------------------------------------------------------------
# Regression tests for the independent security review
# ---------------------------------------------------------------------------

def test_owner_cannot_become_verifier_for_another_departments_training():
    aarav = uid(AARAV)
    with as_user(AARAV) as c:
        c.execute("insert into user_qualifications (user_id, training_tag, evidence_path) values (auth.uid(), 'laser_safety', %s)", (f"{aarav}/x.png",))
    # Dr. Rao (ECE) adds ME's laser training to her own listing...
    rpc(RAO, "save_resource", _res(name="Dummy thing", requirements=[{"type": "training", "value": "laser_safety", "label": "Laser safety"}]))
    q = admin_sql("select id from user_qualifications where user_id=%s and training_tag='laser_safety'", aarav)[0][0]
    # ...but that doesn't let her verify it, read it, or revoke ME's verified certificates
    rpc_fails(RAO, "verify_qualification", str(q), "verified", "ok", None, match="not found")
    assert all(x["training_tag"] != "laser_safety" for x in rpc(RAO, "verification_queue")["qualifications"])
    isha_q = admin_sql("select id, evidence_path from user_qualifications where training_tag='3d_printing' and user_id=%s", uid(ISHA))[0]
    rpc(RAO, "save_resource", _res(name="Another dummy", requirements=[{"type": "training", "value": "3d_printing", "label": "3DP"}]))
    rpc_fails(RAO, "verify_qualification", str(isha_q[0]), "rejected", "sabotage", None, match="not found")
    with as_user(RAO) as c:
        assert c.execute("select _can_read_eligibility_file(%s)", (isha_q[1],)).fetchone()[0] is False
    # Prof. Mehta (ME, owns the laser cutter) can verify it; changing it afterwards is a manager decision
    rpc(MEHTA, "verify_qualification", str(q), "verified", "Induction attended", None)
    rpc_fails(MEHTA, "verify_qualification", str(q), "rejected", "Changed my mind", None, match="already decided")
    rpc(HOD, "verify_qualification", str(q), "rejected", "Attendance sheet does not list him", None)


def test_only_managers_register_new_trainings():
    # An owner can't claim a training name first (tag squatting)
    rpc_fails(RAO, "save_resource", _res(name="Welder", requirements=[{"type": "training", "value": "welding_safety", "label": "Welding"}]), match="not registered")
    assert admin_sql("select count(*) from training_tags where tag='welding_safety'")[0][0] == 0
    # The ME manager registers it on an ME listing; it belongs to ME
    rpc(HOD, "save_resource", _res(name="MIG Welder", requirements=[{"type": "training", "value": "welding_safety", "label": "Welding safety"}]))
    assert admin_sql("select d.code from training_tags t join departments d on d.id=t.department_id where t.tag='welding_safety'")[0][0] == "ME"
    # Other departments may require it; verification stays with ME
    rpc(RAO, "save_resource", _res(name="Fume hood", requirements=[{"type": "training", "value": "welding_safety", "label": "Welding safety"}]))


def test_students_own_manager_cannot_verify_other_departments_training():
    aarav = uid(AARAV)
    with as_user(AARAV) as c:
        c.execute("insert into user_qualifications (user_id, training_tag, evidence_path) values (auth.uid(), 'laser_safety', %s)", (f"{aarav}/x.png",))
    admin_sql("update profiles set role='manager' where email=%s", RAO)   # Rao now manages ECE, Aarav's department
    q = admin_sql("select id from user_qualifications where user_id=%s and training_tag='laser_safety'", aarav)[0][0]
    rpc_fails(RAO, "verify_qualification", str(q), "verified", "ok", None, match="not found")


def test_name_and_year_changes_need_reverification():
    with as_user(KABIR) as c:
        c.execute("update profiles set year_of_study = 6 where id = auth.uid()")
    assert admin_sql("select verification_status from profiles where email=%s", KABIR)[0][0] == "pending"
    with as_user(ISHA) as c:
        c.execute("update profiles set full_name = 'Prof. R. Sharma' where id = auth.uid()")
    assert admin_sql("select verification_status from profiles where email=%s", ISHA)[0][0] == "pending"


def test_cannot_approve_a_slot_past_no_show_grace():
    printer = resource_id("Prusa MK4 3D Printer")
    b = str(admin_sql("""insert into bookings (resource_id, user_id, during, purpose, status)
                          values (%s, (select id from profiles where email=%s), tstzrange(now() - interval '60 minutes', now() + interval '60 minutes'),
                                  'Late approval probe', 'pending_review') returning id""", printer, KABIR)[0][0])
    rpc_fails(MEHTA, "decide_booking", b, "approve", "ok go ahead", False, match="started too long ago")


def test_sweep_grace_counts_from_approval():
    printer = resource_id("Prusa MK4 3D Printer")
    b = str(admin_sql("""insert into bookings (resource_id, user_id, during, purpose, status, decided_at)
                          values (%s, (select id from profiles where email=%s), tstzrange(now() - interval '40 minutes', now() + interval '60 minutes'),
                                  'Approved late probe', 'approved', now() - interval '5 minutes') returning id""", printer, KABIR)[0][0])
    rpc(AARAV, "sweep_due")
    assert admin_sql("select status from bookings where id=%s", b)[0][0] == "approved"


def test_course_code_must_be_registered():
    hall = resource_id("Seminar Hall S-101")
    start, end = ist_slot(5, 10, 120)
    fake = rpc(AARAV, "preview_booking", hall, start, end, 1, "ZZ-000")
    checks = {c["key"]: c for c in fake["checks"]}
    assert checks["req:faculty_sponsor:course"]["ok"] is False and checks["course"]["ok"] is False
    real = rpc(AARAV, "preview_booking", hall, start, end, 1, "ece304")
    checks = {c["key"]: c for c in real["checks"]}
    assert checks["req:faculty_sponsor:course"]["ok"] is True and checks["course"]["ok"] is True
    rpc_fails(AARAV, "request_booking", hall, start, end, 1, "Club meeting with a fake code", "zz", False, match="look like")
    # A real course from an unrelated department (ME) doesn't count for an ECE student booking a CSE hall
    other = rpc(AARAV, "preview_booking", hall, start, end, 1, "ME-201")
    sponsor = next(c for c in other["checks"] if c["key"] == "req:faculty_sponsor:course")
    assert sponsor["ok"] is False and "another department" in sponsor["detail"]


def test_fake_course_gives_no_priority():
    printer = resource_id("Prusa MK4 3D Printer")
    isha_req = admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='pending_review'", ISHA)[0][0]
    admin_sql("update bookings set course_code='ZZ-999' where id=%s", isha_req)
    comp = rpc(MEHTA, "get_booking", str(isha_req))["competition"]
    me = next(q for q in comp["queue"] if q["booking_id"] == str(isha_req))
    assert me["facts"]["course_linked"] is False


def test_checklist_rebuilt_from_template():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    p = photo("condition-photos", f"{b}/{uid(AARAV)}/a.png")
    rpc_fails(AARAV, "check_in", b, '[null,{"key":"x","label":{"evil":1},"ok":true}]', [p], "hi", match="Mark")
    evil = json.loads(answers(b)) + [{"key": "x", "label": {"evil": 1}, "ok": True}, None]
    evil[0]["label"] = {"evil": 1}
    evil[0]["note"] = {"x": 1}
    rpc(AARAV, "check_in", b, json.dumps(evil), [p], "hi")
    stored = admin_sql("select checklist from condition_records where booking_id=%s", b)[0][0]
    tpl = admin_sql("select r.checklist_template from bookings b join resources r on r.id=b.resource_id where b.id=%s", b)[0][0]
    assert [x["key"] for x in stored] == [t["key"] for t in tpl]
    assert all(isinstance(x["label"], str) and isinstance(x["note"], str) for x in stored)


def test_not_ok_needs_a_note():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    p = photo("condition-photos", f"{b}/{uid(AARAV)}/a.png")
    bad = json.loads(answers(b, ok=False)); bad[0]["note"] = ""
    rpc_fails(AARAV, "check_in", b, json.dumps(bad), [p], "", match="Add a note")


def test_photo_must_actually_be_uploaded():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    rpc_fails(AARAV, "check_in", b, answers(b), [f"{b}/{uid(AARAV)}/nothing.jpg"], "", match="not uploaded")
    # a file in the wrong bucket doesn't count either
    p = photo("incident-photos", f"{b}/{uid(AARAV)}/wrong-bucket.jpg")
    rpc_fails(AARAV, "check_in", b, answers(b), [p], "", match="not uploaded")


def test_students_cannot_read_staff_fields_or_queue_facts():
    isha_req = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='pending_review'", ISHA)[0][0])
    admin_sql("update bookings set ai_brief='{\"summary\":\"staff only\"}' where id=%s", isha_req)
    for col in ["ai_brief", "allocation_explanation"]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with as_user(ISHA) as c:
                c.execute(f"select {col} from bookings")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with as_user(ISHA) as c:
            c.execute("select ai_summary from incidents")
    with as_user(ISHA) as c:
        assert c.execute("select count(*) from bookings").fetchone()[0] > 0   # ordinary columns still readable
    for b in rpc(ISHA, "my_bookings"):
        assert "queue" not in (b.get("competition") or {})
    assert "ai_brief" not in json.dumps(rpc(ISHA, "my_bookings"))


def test_strike_limits_and_suspension():
    printer, camera = resource_id("Prusa MK4 3D Printer"), resource_id("Sony A7 III Camera Kit")
    def standing(res, start):
        return next(c for c in rpc(ISHA, "preview_booking", res, start, start + timedelta(hours=1), 1, None)["checks"] if c["key"] == "standing")["ok"]
    start, _ = ist_slot(6, 10, 60)
    admin_sql("update profiles set strikes=2, suspended_until=null where email=%s", ISHA)
    assert standing(camera, start) is False      # camera allows 2 strikes
    assert standing(printer, start) is True      # printer allows 3
    admin_sql("update profiles set strikes=0, suspended_until=now() + interval '1 day' where email=%s", ISHA)
    assert standing(printer, start) is False     # suspended
    admin_sql("update profiles set suspended_until=now() - interval '1 day' where email=%s", ISHA)
    assert standing(printer, start) is True      # suspension served


def test_reaching_strike_limit_suspends_and_resets():
    camera_booking = str(admin_sql("select b.id from bookings b join resources r on r.id=b.resource_id where r.name like 'Sony%%' and b.status='returned'")[0][0])
    admin_sql("update profiles set strikes=1 where email=%s", KABIR)
    inc = rpc(KAPOOR, "report_incident", camera_booking, "damage", "high", "Lens cracked after the shoot", [], None)
    rpc(ADMIN, "resolve_incident", inc["id"], "Crack confirmed against check-in photos", True)
    strikes, suspended = admin_sql("select strikes, suspended_until > now() from profiles where email=%s", KABIR)[0]
    assert strikes == 0 and suspended is True


def test_not_ok_note_must_be_text():
    b = str(admin_sql("select id from bookings where user_id=(select id from profiles where email=%s) and status='approved'", AARAV)[0][0])
    p = photo("condition-photos", f"{b}/{uid(AARAV)}/a.png")
    bad = json.loads(answers(b)); bad[0]["ok"] = False; bad[0]["note"] = {"a": "bb"}
    rpc_fails(AARAV, "check_in", b, json.dumps(bad), [p], "", match="Add a note")


def test_student_cannot_set_expiry_or_backdate():
    with as_user(KABIR) as c:
        c.execute("update user_qualifications set expires_at='2099-12-31', created_at='2000-01-01' where training_tag='drone_rules'")
    row = admin_sql("select expires_at, created_at > now() - interval '1 day' from user_qualifications where training_tag='drone_rules'")[0]
    assert row[0] is None and row[1] is True
    q = admin_sql("select id from user_qualifications where training_tag='drone_rules'")[0][0]
    rpc(KAPOOR, "verify_qualification", str(q), "verified", "Briefing attended", None)
    assert admin_sql("select expires_at from user_qualifications where id=%s", q)[0][0] is None


def test_rate_limit_holds_under_parallel_calls():
    import concurrent.futures
    laser = resource_id("CO2 Laser Cutter 60 W")
    def one(i):
        s, e = ist_slot(5 + i % 15, 9 + (i // 15), 60)
        try:
            rpc(KABIR, "request_booking", laser, s, e, 1, f"Parallel probe number {i}", None, True)
            return True
        except psycopg.Error:
            return False
    with concurrent.futures.ThreadPoolExecutor(12) as ex:
        ok = sum(ex.map(one, range(25)))
    assert ok == 10
    assert admin_sql("select count(*) from bookings where user_id=(select id from profiles where email=%s) and created_at > now() - interval '1 minute'", KABIR)[0][0] == 10


def test_requester_cannot_cancel_after_start():
    b = str(admin_sql("""insert into bookings (resource_id, user_id, during, purpose, status)
                          values (%s, (select id from profiles where email=%s), tstzrange(now() - interval '3 hours', now() - interval '1 hour'),
                                  'Dodging a no-show', 'approved') returning id""", resource_id("Prusa MK4 3D Printer"), KABIR)[0][0])
    rpc_fails(KABIR, "cancel_booking", b, None, match="has started")
    rpc(MEHTA, "cancel_booking", b, "Lab was closed for a power cut")


def test_listing_photos_must_be_project_storage():
    me = uid(MEHTA)
    rid = str(rpc(MEHTA, "save_resource", _res()))
    for bad in [f"http://attacker.example/storage/v1/object/public/resource-photos/{me}/p.png",
                f"https://attacker.example/x/storage/v1/object/public/resource-photos/{me}/p.png",
                f"https://attackerproj.supabase.co/storage/v1/object/public/resource-photos/{me}/p.png",
                f"http://localhost:54321.evil.net/storage/v1/object/public/resource-photos/{me}/p.png",
                f"http://localhost:54321/storage/v1/object/public/resource-photos/{uid(RAO)}/p.png"]:
        rpc_fails(MEHTA, "save_resource", _res(id=rid, photo_urls=[bad]), match="through OpenBench")
    rpc(MEHTA, "save_resource", _res(id=rid, photo_urls=[f"http://localhost:54321/storage/v1/object/public/resource-photos/{me}/p.png"]))
    # A manager adding a photo uses their own folder; the owner's existing photo is kept
    hod = uid(HOD)
    rpc(HOD, "save_resource", _res(id=rid, photo_urls=[f"http://localhost:54321/storage/v1/object/public/resource-photos/{hod}/q.png",
                                                       f"http://localhost:54321/storage/v1/object/public/resource-photos/{me}/p.png"]))


def test_seed_refuses_outside_demo_mode():
    admin_sql("update app_settings set demo_mode=false")
    with pytest.raises(psycopg.Error, match="Demo mode is off"):
        admin_sql("select seed_demo()")
