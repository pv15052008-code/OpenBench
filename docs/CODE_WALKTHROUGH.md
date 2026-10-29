# How OpenBench works, by following one request

This walks one booking from the moment a student taps "Send request" to the closed record, and explains each important piece of code on the way. Read it next to the files it points at.

## The big idea first

Most apps put their rules in the app: "if the student isn't trained, hide the button". That's weak, because anyone can call the database directly with the app's public key and skip the app.

OpenBench puts every rule **inside the database**:

- Students can't write to the `bookings` table at all.
- The only way to create or change a booking is to call a database function, such as `request_booking`, which checks who is calling and whether the rules allow it.
- A trigger writes the audit log on every change, so even a buggy function can't skip it.

The app is a friendly front end over those functions. If the app had a bug, the database would still refuse anything unfair or unsafe.

---

## 1. The student picks a slot: `apps/mobile/src/app/(app)/resources/[id]/request.tsx`

```tsx
const preview = useQuery({
  queryKey: ["preview", id, startAt?.toISOString(), endAt?.toISOString(), qty, course.trim().toUpperCase()],
  enabled: !!startAt && !!endAt,
  queryFn: () => rpc<Preview>("preview_booking", {
    p_resource: id, p_start: startAt!.toISOString(), p_end: endAt!.toISOString(), p_quantity: qty, p_course: course.trim() || null,
  }),
});
```

In plain English: every time the student changes the day, time, length, quantity or course, ask the database what would happen, without saving anything.

- `useQuery` comes from TanStack Query. It runs the function, caches the answer and gives you `preview.data`, `preview.isFetching` and `preview.error`.
- `queryKey` is the cache label. Because the start, end, quantity and course are in the key, changing any of them makes a new query, so the checks re-run by themselves.
- `enabled: !!startAt && !!endAt` means "don't ask until a start and end are chosen". The `!!` turns a value into true or false.
- `rpc("preview_booking", {...})` calls the database function of that name. The `p_` names must match the function's parameter names in SQL.

The screen then shows `pv.outcome` (review, waitlist or blocked) and every check in `pv.checks`. The student sees the result before sending anything.

## 2. The checks: `_booking_checks` in `supabase/migrations/0002_logic.sql`

This function returns a list of checks like this:

```json
[{"key": "weekly_minutes", "group": "fairness", "label": "At most 6.0 hours of this resource per week", "ok": false, "detail": "5.0 h used, 2.0 h requested"}, ...]
```

One example, the weekly-hours check:

```sql
select * into v_usage from _week_usage(p_user, p_res.id, p_start, p_exclude);
v_checks := v_checks || jsonb_build_object('key', 'weekly_minutes', 'group', 'fairness', 'label',
  'At most ' || round(v_pol.max_minutes_per_week / 60.0, 1) || ' hours of this resource per week',
  'ok', v_usage.minutes + v_minutes <= v_pol.max_minutes_per_week,
  'detail', round(v_usage.minutes / 60.0, 1) || ' h used, ' || round(v_minutes / 60.0, 1) || ' h requested');
```

- `_week_usage(...)` adds up this student's bookings of this resource in the same week (Monday to Sunday, India time). Pending requests count too, so nobody can stack requests to get past the cap.
- `v_checks || jsonb_build_object(...)` appends one check object to the list. `||` means "join" for JSON arrays and for text.
- `'ok', v_usage.minutes + v_minutes <= v_pol.max_minutes_per_week` is the actual rule: minutes already used plus minutes asked for must fit within the cap.
- `v_pol` is the fairness policy: the resource's own policy if it has one, otherwise the department's, otherwise a default (`_policy_for`).

Every other check follows the same pattern: account verified, not suspended, each eligibility requirement, notice period, length, opening hours, quantity, weekly bookings, cooldown, and no overlapping request of your own.

## 3. Sending the request: `request_booking`

The important lines, in order:

```sql
perform pg_advisory_xact_lock(hashtext('request:' || auth.uid()::text));
select count(*) into v_recent from bookings where user_id = auth.uid() and created_at > now() - interval '1 hour';
if v_recent >= 10 then raise exception 'Too many requests in the last hour. Try again later.'; end if;
```

- `auth.uid()` is the signed-in user's id, taken from their login token. A student can't fake it.
- The advisory lock makes two requests from the same student wait for each other, so a script firing 25 requests at once can't race past the 10-per-hour limit. The independent security review found that race, and this line fixes it.

```sql
select * into v_res from resources where id = p_resource for update;
```

`for update` locks this resource's row until the transaction ends. If two students request the same slot at the same moment, one waits for the other, so capacity is always counted correctly.

```sql
v_checks := _booking_checks(auth.uid(), v_res, p_start, p_end, coalesce(p_quantity, 1), v_course, null);
v_failed := _failed(v_checks);
if v_failed is not null then
  v_status := 'blocked';
else
  v_free := _slot_free(v_res, p_start, p_end, coalesce(p_quantity, 1), null);
  v_status := case when v_free then 'pending_review' else 'waitlisted' end;
end if;
```

The database re-runs every check itself. It never trusts the preview the app showed. Failed checks mean `blocked`. If the checks pass but the slot is taken, the request is `waitlisted`; otherwise it's `pending_review`. The request is saved in every case, so even a blocked one appears in the register with its reason.

## 4. Double-booking is impossible: `0001_schema.sql`

```sql
constraint bookings_no_overlap exclude using gist (resource_id with =, during with &&)
  where (status in ('approved', 'checked_in', 'overdue') and not pooled)
```

In plain English: no two rows may have the same resource and overlapping times while both are approved, in use or overdue.

- `during` is a `tstzrange`: a start and end time stored as one value.
- `&&` means "overlaps".
- `exclude using gist` tells Postgres to enforce this on every insert and update. If two owners approve clashing requests in the same millisecond, Postgres refuses the second one. App code can't race past it.
- Pooled resources (such as 10 Arduino kits) are excluded here and checked by `_slot_free`, which adds up quantities under the row lock.

## 5. The audit log writes itself: `booking_status_trigger`

```sql
create trigger bookings_status after insert or update of status on bookings
  for each row execute function booking_status_trigger();
```

Whenever a booking's status changes, Postgres runs `booking_status_trigger`, which:

1. Checks the move is allowed by `booking_transition_allowed` (for example, `approved` → `checked_in` is allowed; `requested` → `closed` is not).
2. Inserts a row into `audit_log` with who did it (`auth.uid()`), their role, the old and new status, and the reason.
3. Sends notifications to the people who need to know.

The reason comes from `_set_context(action, reason)`, which each function calls just before changing a status. It stores the reason in a setting that lasts only for this transaction, and the trigger reads it back.

## 6. Who can see what: row-level security in `0003_policies.sql`

```sql
create policy bookings_read on bookings for select to authenticated
  using (user_id = auth.uid() or can_manage_resource(resource_id));
```

Every time anyone reads `bookings`, Postgres adds this condition by itself: you see a row only if it's your booking, or you manage the resource. A student who writes `select * from bookings` gets only their own rows. No app code is needed for this.

```sql
grant select (id, resource_id, user_id, during, ...) on bookings to authenticated;
```

This is a column-level grant. Students can read the normal columns of their bookings, but not `ai_brief` (the staff summary) or `allocation_explanation` (which holds other students' ranking facts).

## 7. The owner decides: `decide_booking`

```sql
if v_b.user_id = auth.uid() then
  raise exception 'You cannot decide on your own request; another manager must review it';
end if;
v_reason := _require_reason(p_reason);
```

Two trust rules in two lines: nobody approves their own request, and every decision needs a reason of at least 5 characters. That reason is what the student sees.

When an approval makes other overlapping requests impossible, those requests are moved to the waitlist with an explanation. They are never rejected automatically: a person makes every rejection.

## 8. Check-in and return: `check_in`, `return_booking`, `_clean_checklist`

```sql
perform _assert_own_paths(p_photos, p_booking, 'condition-photos');
insert into condition_records (booking_id, phase, checklist, photo_paths, notes, recorded_by)
values (p_booking, 'checkin', _clean_checklist(p_booking, p_checklist), p_photos, ...);
```

- `_assert_own_paths` makes sure each photo sits in `<booking id>/<your user id>/`, so nobody can attach someone else's upload, and that the file really was uploaded.
- `_clean_checklist` rebuilds the checklist from the owner's template. The student only supplies OK / not OK and a note. Anything else they send is ignored, and every "not OK" item needs a note.

## 9. The AI brief: `services/api/app/main.py`

```python
@app.post("/ai/brief/{booking_id}")
async def brief(booking_id: uuid.UUID, caller: Caller = Depends(current_user), client=Depends(http)):
    limit(f"ai:{caller.id}", 30, 60)
    queue = await as_user(caller.token, client).rpc("review_queue")
    item = next((r for r in (queue or {}).get("requests", []) if r.get("id") == str(booking_id)), None)
    if item is None:
        raise HTTPException(404, "Request not found in your review queue")
    result = await ai.request_brief(client, item)
    await service(client).update("bookings", {"id": str(booking_id)}, {"ai_brief": result})
    return result
```

- `booking_id: uuid.UUID` makes FastAPI reject anything that isn't a valid id before the function runs.
- `Depends(current_user)` checks the caller's login token with Supabase and gives you their id.
- `limit(...)` allows 30 AI calls per user per minute.
- `as_user(caller.token).rpc("review_queue")` asks the database **as that user** for their review queue. If the booking isn't in it, they don't manage it, and the function stops with 404.
- Only then does `service(client)` use the secret service key, to write the brief into the booking.
- `ai.request_brief` calls Gemini. If there is no key or the call fails, it builds the brief from rules instead and labels it as such.

## 10. Where to look for anything else

| You want to understand | Read |
| --- | --- |
| The tables | `supabase/migrations/0001_schema.sql` |
| Every rule and lifecycle step | `supabase/migrations/0002_logic.sql` |
| Who can read and call what | `supabase/migrations/0003_policies.sql`, `0004_storage.sql` |
| What the tests prove | `supabase/tests/test_db.py` (each test name says what it checks) |
| The app's building blocks | `apps/mobile/src/components/ui.tsx`, `domain.tsx` |
| Signing in and roles in the app | `apps/mobile/src/lib/auth.tsx` |
