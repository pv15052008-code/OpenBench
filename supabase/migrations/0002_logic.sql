-- OpenBench · 0002 logic
-- Every state change in the booking lifecycle goes through one of the functions
-- below. Clients have no UPDATE rights on bookings, incidents or condition
-- records (see 0003), so these functions are the only door, and each one checks
-- who is calling before it does anything.
--
-- Conventions
--   _name(...)  internal helper, not callable by clients
--   name(...)   RPC callable by signed-in users (granted at the end of 0003)
--   Every SECURITY DEFINER function pins search_path so a malicious schema
--   cannot shadow a table or function name.

-- ===========================================================================
-- 1. Who is calling
-- ===========================================================================

-- The caller's profile row, or null for the service role / system jobs.
create or replace function _me() returns profiles
language sql stable security definer set search_path = public, pg_temp as $$
  select p from profiles p where p.id = auth.uid()
$$;

create or replace function _role() returns user_role
language sql stable security definer set search_path = public, pg_temp as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = 'admin' and verification_status = 'verified' from profiles where id = auth.uid()), false)
$$;

-- Admins manage everything; managers manage their own department.
create or replace function is_manager_of(p_department uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select verification_status = 'verified'
       and (role = 'admin' or (role = 'manager' and department_id = p_department))
    from profiles where id = auth.uid()), false)
$$;

-- Owner of the resource, a manager of its department, or an admin.
create or replace function can_manage_resource(p_resource uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select (r.owner_id = auth.uid() and exists (select 1 from profiles p where p.id = auth.uid() and p.verification_status = 'verified'))
           or is_manager_of(r.department_id)
    from resources r where r.id = p_resource), false)
$$;

create or replace function can_view_booking(p_booking uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select b.user_id = auth.uid() or can_manage_resource(b.resource_id)
    from bookings b where b.id = p_booking), false)
$$;

-- True inside our own SECURITY DEFINER functions (they run as the table owner)
-- and for the service role; false for a client talking to the table directly.
create or replace function _privileged() returns boolean
language sql stable as $$
  select current_user not in ('authenticated', 'anon')
$$;

-- True only inside seed_demo(); lets lifecycle triggers stand aside while it writes history.
create or replace function _seeding() returns boolean
language sql stable as $$
  select coalesce(current_setting('openbench.seeding', true), '') = 'on'
$$;

create or replace function _settings() returns app_settings
language sql stable security definer set search_path = public, pg_temp as $$
  select s from app_settings s where s.id
$$;

-- Small card about a person that is safe to show to the other party.
create or replace function _person_card(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.id is null then null else jsonb_build_object(
    'id', p.id, 'full_name', p.full_name, 'role', p.role,
    'department', d.code, 'year_of_study', p.year_of_study,
    'verified', p.verification_status = 'verified', 'avatar_url', p.avatar_url)
  end
  from profiles p left join departments d on d.id = p.department_id
  where p.id = p_id
$$;

-- "ece304", "ECE 304" and "ECE-304" all mean course ECE-304
create or replace function _norm_course(p text) returns text
language sql immutable as $$
  select case when p is null or btrim(p) = '' then null
              else regexp_replace(upper(regexp_replace(p, '[^A-Za-z0-9]', '', 'g')), '^([A-Z]{2,4})([0-9]{3})$', '\1-\2') end
$$;

-- Used by RPCs to require a reason of meaningful length.
create or replace function _require_reason(p_reason text, p_min int default 5) returns text
language plpgsql immutable as $$
begin
  if p_reason is null or length(btrim(p_reason)) < p_min then
    raise exception 'A reason of at least % characters is required', p_min using errcode = '22023';
  end if;
  return btrim(p_reason);
end $$;

-- Every photo a caller attaches must live under <booking_id>/<caller_id>/ in its bucket,
-- so nobody can attach somebody else's upload to their record.
create or replace function _assert_own_paths(p_paths text[], p_booking uuid, p_bucket text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_path text;
begin
  if p_paths is null then return; end if;
  if cardinality(p_paths) > 8 then
    raise exception 'At most 8 photos per record' using errcode = '22023';
  end if;
  foreach v_path in array p_paths loop
    if v_path is null or v_path !~ ('^' || p_booking::text || '/' || auth.uid()::text || '/[A-Za-z0-9._-]{1,120}$') then
      raise exception 'Photo path % does not belong to this booking and user', coalesce(v_path, 'null') using errcode = '42501';
    end if;
    -- The file must really have been uploaded: a record with no evidence protects nobody
    if not exists (select 1 from storage.objects o where o.bucket_id = p_bucket and o.name = v_path) then
      raise exception 'Photo % was not uploaded; try again', v_path using errcode = '22023';
    end if;
  end loop;
end $$;

-- The checklist stored for a check-in or return is rebuilt from the owner's template:
-- each item keeps the owner's key and label, plus the user's ok (true/false) and a
-- short note. Anything else the client sends is ignored, and every item must be answered.
create or replace function _clean_checklist(p_booking uuid, p_checklist jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_template jsonb;
  v_item     jsonb;
  v_answer   jsonb;
  v_note     text;
  v_out      jsonb := '[]'::jsonb;
begin
  if p_checklist is null or jsonb_typeof(p_checklist) <> 'array' then
    raise exception 'Fill in the condition checklist' using errcode = '22023';
  end if;
  select r.checklist_template into v_template from bookings b join resources r on r.id = b.resource_id where b.id = p_booking;
  if v_template is null or jsonb_array_length(v_template) = 0 then
    v_template := '[{"key":"condition","label":"Overall condition as expected"}]';
  end if;
  for v_item in select * from jsonb_array_elements(v_template) loop
    select e into v_answer from jsonb_array_elements(p_checklist) e
    where jsonb_typeof(e) = 'object' and e->>'key' = v_item->>'key' limit 1;
    if v_answer is null or jsonb_typeof(v_answer->'ok') <> 'boolean' then
      raise exception 'Mark "%" as OK or not OK', v_item->>'label' using errcode = '22023';
    end if;
    -- Only a text note counts; it's checked exactly as it will be stored
    v_note := left(btrim(case when jsonb_typeof(v_answer->'note') = 'string' then v_answer->>'note' else '' end), 200);
    if not (v_answer->>'ok')::boolean and length(v_note) < 2 then
      raise exception 'Add a note for "%"', v_item->>'label' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_object('key', v_item->>'key', 'label', v_item->>'label',
      'ok', (v_answer->>'ok')::boolean, 'note', v_note);
  end loop;
  return v_out;
end $$;

-- ===========================================================================
-- 2. Profiles: created from auth.users, protected columns
-- ===========================================================================

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domains text[] := (select allowed_email_domains from app_settings where id);
  v_domain  text := lower(split_part(new.email, '@', 2));
  v_name    text := btrim(coalesce(new.raw_user_meta_data->>'full_name', ''));
begin
  if cardinality(v_domains) > 0 and not (v_domain = any (select lower(unnest(v_domains)))) then
    raise exception 'Sign-up is limited to institution email addresses' using errcode = '42501';
  end if;
  if length(v_name) < 2 then v_name := split_part(new.email, '@', 1); end if;
  insert into profiles (id, email, full_name) values (new.id, lower(new.email), left(v_name, 80));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- A user may edit their own name, department, year, roll number and avatar.
-- Role, verification, strikes and suspension can only change inside our RPCs.
create or replace function protect_profile_columns() returns trigger
language plpgsql as $$
begin
  if _privileged() or _seeding() then return new; end if;
  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.role is distinct from old.role
     or new.verification_status is distinct from old.verification_status
     or new.verified_by is distinct from old.verified_by
     or new.verified_at is distinct from old.verified_at
     or new.strikes is distinct from old.strikes
     or new.suspended_until is distinct from old.suspended_until
     or new.created_at is distinct from old.created_at then
    raise exception 'You cannot change role, verification or standing fields' using errcode = '42501';
  end if;
  -- Changing name, department, year or roll number after verification sends the account back for review,
  -- so nobody can promote themselves to a later year or rename themselves as staff
  if old.verification_status = 'verified'
     and (new.department_id is distinct from old.department_id or new.roll_number is distinct from old.roll_number
          or new.year_of_study is distinct from old.year_of_study or new.full_name is distinct from old.full_name) then
    new.verification_status := 'pending';
    new.verified_by := null;
    new.verified_at := null;
  end if;
  return new;
end $$;

create trigger profiles_protect before update on profiles
  for each row execute function protect_profile_columns();

-- ===========================================================================
-- 3. Qualifications and resources: force safe defaults on client writes
-- ===========================================================================

create or replace function protect_qualification() returns trigger
language plpgsql as $$
begin
  if _privileged() then return new; end if;
  if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.training_tag is distinct from old.training_tag) then
    raise exception 'Upload a new qualification instead of changing this one' using errcode = '42501';
  end if;
  -- Anything the user writes goes back to pending; only a reviewer verifies.
  new.status := 'pending';
  new.verified_by := null;
  new.verified_at := null;
  new.decision_reason := null;
  new.expires_at := case when tg_op = 'UPDATE' then old.expires_at else null end;
  new.created_at := case when tg_op = 'UPDATE' then old.created_at else now() end;
  new.ai_review := case when tg_op = 'UPDATE' and new.evidence_path is not distinct from old.evidence_path then old.ai_review else null end;
  if new.evidence_path is not null and new.evidence_path !~ ('^' || auth.uid()::text || '/[A-Za-z0-9._-]{1,120}$') then
    raise exception 'Evidence must be uploaded to your own folder' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger qualifications_protect before insert or update on user_qualifications
  for each row execute function protect_qualification();

create or replace function protect_resource() returns trigger
language plpgsql as $$
begin
  if _privileged() then return new; end if;
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id and not is_manager_of(old.department_id) then
    raise exception 'Only a manager can transfer a resource' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.department_id is distinct from old.department_id and not is_admin() then
    raise exception 'Only an admin can move a resource to another department' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(new.photo_urls) u where u !~ '^https://') then
    raise exception 'Photo URLs must be https' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger resources_protect before insert or update on resources
  for each row execute function protect_resource();

-- ===========================================================================
-- 4. Audit log and notifications (written by triggers, never by clients)
-- ===========================================================================

create or replace function _audit(p_entity audit_entity, p_id uuid, p_action text,
                                  p_from text, p_to text, p_reason text, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, from_state, to_state, reason, metadata)
  values (auth.uid(), _role(), p_entity, p_id, p_action, p_from, p_to,
          nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_meta, '{}'::jsonb));
end $$;

create or replace function _notify(p_user uuid, p_type text, p_title text, p_body text, p_booking uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is null then return; end if;
  insert into notifications (user_id, type, title, body, booking_id)
  values (p_user, p_type, left(p_title, 120), left(coalesce(p_body, ''), 600), p_booking);
end $$;

-- Notify everyone who manages a resource except the actor themselves.
create or replace function _notify_managers(p_resource uuid, p_type text, p_title text, p_body text, p_booking uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid;
begin
  for v_uid in
    select distinct u from (
      select r.owner_id as u from resources r where r.id = p_resource
      union
      select p.id from profiles p join resources r on r.id = p_resource
      where p.role = 'manager' and p.department_id = r.department_id and p.verification_status = 'verified'
    ) s where u is distinct from auth.uid()
  loop
    perform _notify(v_uid, p_type, p_title, p_body, p_booking);
  end loop;
end $$;

-- Which status moves are legal. Anything else is refused by the trigger below,
-- even if a future RPC has a bug.
create or replace function booking_transition_allowed(p_from booking_status, p_to booking_status) returns boolean
language sql immutable as $$
  select (p_from, p_to) in (
    ('requested', 'pending_review'), ('requested', 'blocked'), ('requested', 'waitlisted'),
    ('blocked', 'approved'), ('blocked', 'cancelled'), ('blocked', 'rejected'),
    ('pending_review', 'approved'), ('pending_review', 'rejected'), ('pending_review', 'waitlisted'), ('pending_review', 'cancelled'),
    ('waitlisted', 'pending_review'), ('waitlisted', 'approved'), ('waitlisted', 'rejected'), ('waitlisted', 'cancelled'),
    ('approved', 'checked_in'), ('approved', 'cancelled'), ('approved', 'no_show'),
    ('checked_in', 'returned'), ('checked_in', 'overdue'),
    ('overdue', 'returned'),
    ('returned', 'closed'), ('returned', 'disputed'),
    ('closed', 'disputed'),
    ('disputed', 'closed')
  )
$$;

create or replace function booking_status_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res     resources;
  v_reason  text := nullif(current_setting('openbench.reason', true), '');
  v_action  text := coalesce(nullif(current_setting('openbench.action', true), ''), 'status_change');
  v_title   text;
  v_body    text;
  v_when    text;
begin
  if _seeding() then return new; end if;
  select * into v_res from resources where id = new.resource_id;
  v_when := to_char(lower(new.during) at time zone (select timezone from app_settings where id), 'Dy DD Mon, HH24:MI');

  if tg_op = 'INSERT' then
    perform _audit('booking', new.id, 'request_submitted', null, new.status::text,
                   coalesce(v_reason, new.decision_reason),
                   jsonb_build_object('resource', v_res.name, 'during', new.during::text, 'checks', new.allocation_explanation->'checks'));
    if new.status = 'pending_review' then
      perform _notify(new.user_id, 'request_received', 'Request sent for ' || v_res.name,
                      'All automatic checks passed. The owner will review it. Slot: ' || v_when, new.id);
      perform _notify_managers(new.resource_id, 'review_needed', 'New request: ' || v_res.name,
                      'A request for ' || v_when || ' is waiting for your review.', new.id);
    elsif new.status = 'waitlisted' then
      perform _notify(new.user_id, 'waitlisted', 'Waitlisted for ' || v_res.name,
                      'That slot is already taken. You will be moved up automatically if it frees.', new.id);
      perform _notify_managers(new.resource_id, 'waitlist_added', 'Waitlist request: ' || v_res.name,
                      'Someone joined the waitlist for ' || v_when || '.', new.id);
    elsif new.status = 'blocked' then
      perform _notify(new.user_id, 'blocked', 'Request blocked: ' || v_res.name, new.decision_reason, new.id);
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not booking_transition_allowed(old.status, new.status) then
    raise exception 'Booking cannot move from % to %', old.status, new.status using errcode = '22023';
  end if;

  perform _audit('booking', new.id, v_action, old.status::text, new.status::text,
                 coalesce(v_reason, new.decision_reason), jsonb_build_object('resource', v_res.name));

  v_title := case new.status
    when 'approved'       then 'Approved: ' || v_res.name
    when 'rejected'       then 'Not approved: ' || v_res.name
    when 'waitlisted'     then 'Moved to waitlist: ' || v_res.name
    when 'pending_review' then 'Back in review: ' || v_res.name
    when 'cancelled'      then 'Cancelled: ' || v_res.name
    when 'checked_in'     then 'Checked in: ' || v_res.name
    when 'returned'       then 'Returned: ' || v_res.name
    when 'closed'         then 'Booking closed: ' || v_res.name
    when 'disputed'       then 'Issue reported: ' || v_res.name
    when 'no_show'        then 'Missed slot: ' || v_res.name
    when 'overdue'        then 'Overdue: ' || v_res.name
    else 'Update: ' || v_res.name end;
  v_body := coalesce(v_reason, new.decision_reason, '') ;

  -- The person who booked hears about everything they did not do themselves.
  if new.user_id is distinct from auth.uid() then
    perform _notify(new.user_id, 'booking_' || new.status::text, v_title, v_body, new.id);
  end if;
  -- Managers hear about the moments where they need to act or know.
  if new.status in ('cancelled', 'checked_in', 'returned', 'disputed', 'no_show', 'overdue', 'pending_review') then
    perform _notify_managers(new.resource_id, 'booking_' || new.status::text, v_title,
      case new.status
        when 'returned' then 'Check the return photos and confirm the condition.'
        when 'pending_review' then 'A waitlisted request is back in your review queue.'
        else v_body end, new.id);
  end if;
  return new;
end $$;

create trigger bookings_status after insert or update of status on bookings
  for each row execute function booking_status_trigger();

-- Guard runs BEFORE update so an illegal move never lands.
create or replace function booking_guard() returns trigger
language plpgsql as $$
begin
  if _seeding() then return new; end if;
  if new.status is distinct from old.status and not booking_transition_allowed(old.status, new.status) then
    raise exception 'Booking cannot move from % to %', old.status, new.status using errcode = '22023';
  end if;
  if new.user_id is distinct from old.user_id or new.resource_id is distinct from old.resource_id then
    raise exception 'A booking cannot change its user or resource' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger bookings_guard before update on bookings
  for each row execute function booking_guard();

create or replace function audit_other() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reason text := nullif(current_setting('openbench.reason', true), '');
begin
  if _seeding() then return new; end if;
  if tg_table_name = 'resources' then
    if tg_op = 'INSERT' then
      perform _audit('resource', new.id, 'resource_listed', null, new.status::text, null, jsonb_build_object('name', new.name));
    elsif new.status is distinct from old.status then
      perform _audit('resource', new.id, 'resource_status', old.status::text, new.status::text, v_reason, jsonb_build_object('name', new.name));
    elsif row(new.usage_rules, new.max_minutes_per_booking, new.lead_time_hours, new.quantity) is distinct from
          row(old.usage_rules, old.max_minutes_per_booking, old.lead_time_hours, old.quantity) then
      perform _audit('resource', new.id, 'resource_rules_changed', null, null, null, jsonb_build_object('name', new.name));
    end if;
  elsif tg_table_name = 'user_qualifications' then
    if tg_op = 'INSERT' or new.status is distinct from old.status then
      perform _audit('qualification', new.id,
        case when tg_op = 'INSERT' then 'qualification_submitted' else 'qualification_' || new.status::text end,
        case when tg_op = 'INSERT' then null else old.status::text end, new.status::text,
        coalesce(v_reason, new.decision_reason), jsonb_build_object('user_id', new.user_id, 'tag', new.training_tag));
      if tg_op = 'UPDATE' and new.status in ('verified', 'rejected') then
        perform _notify(new.user_id, 'qualification_' || new.status::text,
          'Training ' || replace(new.training_tag, '_', ' ') || ' ' || new.status::text, coalesce(new.decision_reason, ''), null);
      end if;
    end if;
  elsif tg_table_name = 'incidents' then
    if tg_op = 'INSERT' then
      perform _audit('incident', new.id, 'incident_reported', null, 'open', new.description,
        jsonb_build_object('booking_id', new.booking_id, 'type', new.type, 'severity', new.severity));
    elsif new.status is distinct from old.status then
      perform _audit('incident', new.id, 'incident_' || new.status::text, old.status::text, new.status::text,
        coalesce(v_reason, new.resolution), jsonb_build_object('booking_id', new.booking_id, 'strike', new.strike_applied));
    end if;
  elsif tg_table_name = 'profiles' then
    if new.role is distinct from old.role or new.verification_status is distinct from old.verification_status
       or new.strikes is distinct from old.strikes then
      perform _audit('profile', new.id, 'profile_standing',
        old.role::text || '/' || old.verification_status::text || '/' || old.strikes,
        new.role::text || '/' || new.verification_status::text || '/' || new.strikes, v_reason, '{}'::jsonb);
    end if;
  end if;
  return new;
end $$;

create trigger resources_audit after insert or update on resources for each row execute function audit_other();
create trigger qualifications_audit after insert or update on user_qualifications for each row execute function audit_other();
create trigger incidents_audit after insert or update on incidents for each row execute function audit_other();
create trigger profiles_audit after update on profiles for each row execute function audit_other();

-- Sets the reason/action the triggers above will record for this transaction.
create or replace function _set_context(p_action text, p_reason text) returns void
language sql as $$
  select set_config('openbench.action', coalesce(p_action, ''), true),
         set_config('openbench.reason', coalesce(p_reason, ''), true);
$$;

-- ===========================================================================
-- 5. Fairness, eligibility and the automatic checks
-- ===========================================================================

create or replace function _policy_for(p_res resources) returns fairness_policies
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select f from fairness_policies f where f.resource_id = p_res.id),
    (select f from fairness_policies f where f.department_id = p_res.department_id),
    row(null, null, null, 3, 480, 0, true, 3, now())::fairness_policies)
$$;

-- Statuses that count as "using" a resource for caps and history.
create or replace function _counts_as_usage(p_status booking_status) returns boolean
language sql immutable as $$
  select p_status in ('pending_review', 'approved', 'checked_in', 'returned', 'closed', 'overdue', 'disputed', 'no_show')
$$;

create or replace function _week_bounds(p_at timestamptz, out ws timestamptz, out we timestamptz)
language plpgsql stable as $$
declare v_tz text := (select timezone from app_settings where id);
begin
  ws := date_trunc('week', p_at at time zone v_tz) at time zone v_tz;
  we := ws + interval '7 days';
end $$;

create or replace function _week_usage(p_user uuid, p_resource uuid, p_at timestamptz, p_exclude uuid,
                                       out bookings int, out minutes int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_ws timestamptz; v_we timestamptz;
begin
  select w.ws, w.we into v_ws, v_we from _week_bounds(p_at) w;
  select count(*)::int, coalesce(sum(extract(epoch from upper(b.during) - lower(b.during)) / 60), 0)::int
    into bookings, minutes
  from bookings b
  where b.user_id = p_user and b.resource_id = p_resource
    and lower(b.during) >= v_ws and lower(b.during) < v_we
    and _counts_as_usage(b.status)
    and b.id is distinct from p_exclude;
end $$;

-- One entry per requirement on the resource: is it met for this user, and why not.
create or replace function _eligibility(p_user uuid, p_resource uuid, p_on date default current_date, p_course text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_profile profiles;
  v_dept    text;
  v_req     resource_requirements;
  v_ok      boolean;
  v_detail  text;
  v_out     jsonb := '[]'::jsonb;
  v_q       user_qualifications;
begin
  select * into v_profile from profiles where id = p_user;
  select code into v_dept from departments where id = v_profile.department_id;
  for v_req in select * from resource_requirements where resource_id = p_resource order by type, value loop
    v_ok := false; v_detail := null;
    if v_req.type = 'training' then
      select * into v_q from user_qualifications where user_id = p_user and training_tag = v_req.value;
      if v_q.id is null then
        v_detail := 'No certificate uploaded for this training';
      elsif v_q.status = 'pending' then
        v_detail := 'Certificate uploaded, waiting for verification';
      elsif v_q.status = 'rejected' then
        v_detail := 'Certificate rejected: ' || coalesce(v_q.decision_reason, 'see notification');
      elsif v_q.status = 'verified' and v_q.expires_at is not null and v_q.expires_at < p_on then
        v_detail := 'Training expired on ' || to_char(v_q.expires_at, 'DD Mon YYYY');
      elsif v_q.status = 'verified' then
        v_ok := true; v_detail := 'Verified' || coalesce(' until ' || to_char(v_q.expires_at, 'DD Mon YYYY'), '');
      else
        v_detail := 'Training ' || v_q.status::text;
      end if;
    elsif v_req.type = 'min_year' then
      v_ok := coalesce(v_profile.year_of_study, 0) >= v_req.value::int or v_profile.role in ('manager', 'admin');
      v_detail := case when v_ok then 'Year ' || coalesce(v_profile.year_of_study::text, 'staff')
                       else 'Your profile shows year ' || coalesce(v_profile.year_of_study::text, 'not set') end;
    elsif v_req.type = 'department' then
      v_ok := v_dept = v_req.value;
      v_detail := case when v_ok then 'Member of ' || v_dept else 'Limited to ' || v_req.value || ' department' end;
    elsif v_req.type = 'faculty_sponsor' then
      -- A registered course from the student's own department, or from the department that owns the resource
      v_ok := exists (select 1 from courses c join resources r on r.id = p_resource
                      where c.code = p_course and c.active and c.department_id in (v_profile.department_id, r.department_id))
              or v_profile.role in ('owner', 'manager', 'admin');
      v_detail := case
        when v_profile.role in ('owner', 'manager', 'admin') then 'Staff account'
        when v_ok then 'Linked to ' || p_course
        when exists (select 1 from courses c where c.code = p_course and c.active) then p_course || ' belongs to another department'
        when p_course is not null then p_course || ' is not a registered course'
        else 'Add the course code of the supervising faculty' end;
    end if;
    v_out := v_out || jsonb_build_object('key', 'req:' || v_req.type || ':' || v_req.value, 'group', 'eligibility',
                                         'label', v_req.label, 'ok', v_ok, 'detail', v_detail);
  end loop;
  return v_out;
end $$;

-- Can the slot hold this many units, ignoring p_exclude?
create or replace function _slot_free(p_res resources, p_start timestamptz, p_end timestamptz, p_qty int, p_exclude uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_res.quantity = 1 then not exists (
      select 1 from bookings b
      where b.resource_id = p_res.id and b.id is distinct from p_exclude
        and b.status in ('approved', 'checked_in', 'overdue')
        and b.during && tstzrange(p_start, p_end))
    else coalesce((
      select max(used) from (
        -- peak simultaneous usage inside the window: check at every start point that overlaps
        select (select coalesce(sum(b2.quantity), 0) from bookings b2
                 where b2.resource_id = p_res.id and b2.id is distinct from p_exclude
                   and b2.status in ('approved', 'checked_in', 'overdue')
                   and b2.during @> greatest(lower(b1.during), p_start)) as used
        from bookings b1
        where b1.resource_id = p_res.id and b1.id is distinct from p_exclude
          and b1.status in ('approved', 'checked_in', 'overdue')
          and b1.during && tstzrange(p_start, p_end)
      ) peaks), 0) + p_qty <= p_res.quantity
  end
$$;

-- Every automatic check for a request, as a list the UI can show line by line.
create or replace function _booking_checks(p_user uuid, p_res resources, p_start timestamptz, p_end timestamptz,
                                           p_qty int, p_course text, p_exclude uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_s        app_settings := _settings();
  v_profile  profiles;
  v_pol      fairness_policies := _policy_for(p_res);
  v_checks   jsonb := '[]'::jsonb;
  v_minutes  int := (extract(epoch from p_end - p_start) / 60)::int;
  v_local_s  timestamp := p_start at time zone v_s.timezone;
  v_local_e  timestamp := p_end at time zone v_s.timezone;
  v_has_rules boolean;
  v_in_hours boolean;
  v_blackout boolean;
  v_usage    record;
  v_last_ret timestamptz;
  v_dup      boolean;
begin
  select * into v_profile from profiles where id = p_user;

  v_checks := v_checks || jsonb_build_object('key', 'account', 'group', 'account', 'label', 'Verified institution account',
    'ok', v_profile.verification_status = 'verified',
    'detail', case v_profile.verification_status when 'verified' then 'Verified' when 'pending' then 'Waiting for admin verification' else 'Verification rejected' end);

  v_checks := v_checks || jsonb_build_object('key', 'standing', 'group', 'account', 'label', 'Good standing',
    -- Blocked while suspended, or when this resource's strike limit is reached.
    -- Strikes reset when a suspension starts, so a served suspension doesn't block forever.
    'ok', (v_profile.suspended_until is null or v_profile.suspended_until < now()) and v_profile.strikes < v_pol.max_open_strikes,
    'detail', case
      when v_profile.suspended_until > now() then 'Suspended until ' || to_char(v_profile.suspended_until at time zone v_s.timezone, 'DD Mon YYYY')
      else v_profile.strikes || ' of ' || v_pol.max_open_strikes || ' strikes' end);

  v_checks := v_checks || jsonb_build_object('key', 'resource_active', 'group', 'resource', 'label', 'Resource is open for booking',
    'ok', p_res.status = 'active',
    'detail', case p_res.status when 'active' then 'Active' when 'maintenance' then 'Under maintenance' else 'Not available' end);

  v_checks := v_checks || _eligibility(p_user, p_res.id, (p_start at time zone v_s.timezone)::date, p_course);

  if p_course is not null then
    v_checks := v_checks || jsonb_build_object('key', 'course', 'group', 'eligibility', 'label', 'Course code is registered',
      'ok', exists (select 1 from courses c where c.code = p_course and c.active),
      'detail', coalesce((select c.code || ': ' || c.name from courses c where c.code = p_course and c.active), p_course || ' is not a registered course'));
  end if;

  v_checks := v_checks || jsonb_build_object('key', 'notice', 'group', 'time', 'label',
    case when p_res.lead_time_hours = 0 then 'Starts now or later' else 'Requested at least ' || p_res.lead_time_hours || ' h ahead' end,
    'ok', p_start >= now() + make_interval(hours => p_res.lead_time_hours) - interval '15 minutes'
          and p_start <= now() + make_interval(days => p_res.max_advance_days),
    'detail', case
      when p_start > now() + make_interval(days => p_res.max_advance_days) then 'Bookings open ' || p_res.max_advance_days || ' days ahead'
      when p_start < now() + make_interval(hours => p_res.lead_time_hours) - interval '15 minutes' then 'Too soon or in the past'
      else 'OK' end);

  v_checks := v_checks || jsonb_build_object('key', 'duration', 'group', 'time', 'label',
    'Between ' || p_res.slot_minutes || ' and ' || p_res.max_minutes_per_booking || ' minutes, in ' || p_res.slot_minutes || '-minute steps',
    'ok', v_minutes >= p_res.slot_minutes and v_minutes <= p_res.max_minutes_per_booking and v_minutes % p_res.slot_minutes = 0,
    'detail', v_minutes || ' minutes requested');

  v_has_rules := exists (select 1 from availability_rules a where a.resource_id = p_res.id and a.weekday is not null);
  v_in_hours := not v_has_rules or (
    v_local_s::date = (v_local_e - interval '1 microsecond')::date
    and exists (select 1 from availability_rules a
                where a.resource_id = p_res.id and a.weekday = extract(dow from v_local_s)::int
                  and v_local_s::time >= a.opens_at
                  and (v_local_e::time <= a.closes_at or (v_local_e::time = '00:00' and a.closes_at = '23:59'))));
  v_blackout := exists (select 1 from availability_rules a where a.resource_id = p_res.id
                        and a.blackout_date between v_local_s::date and (v_local_e - interval '1 microsecond')::date);
  v_checks := v_checks || jsonb_build_object('key', 'hours', 'group', 'time', 'label', 'Inside opening hours',
    'ok', v_in_hours and not v_blackout,
    'detail', case when v_blackout then 'Closed that day' when not v_in_hours then 'Outside opening hours' else 'Open' end);

  v_checks := v_checks || jsonb_build_object('key', 'quantity', 'group', 'resource', 'label', 'Quantity available in total',
    'ok', p_qty between 1 and p_res.quantity, 'detail', p_qty || ' of ' || p_res.quantity);

  select * into v_usage from _week_usage(p_user, p_res.id, p_start, p_exclude);
  v_checks := v_checks || jsonb_build_object('key', 'weekly_bookings', 'group', 'fairness', 'label',
    'At most ' || v_pol.max_bookings_per_week || ' bookings of this resource per week',
    'ok', v_usage.bookings + 1 <= v_pol.max_bookings_per_week,
    'detail', v_usage.bookings || ' already this week');
  v_checks := v_checks || jsonb_build_object('key', 'weekly_minutes', 'group', 'fairness', 'label',
    'At most ' || round(v_pol.max_minutes_per_week / 60.0, 1) || ' hours of this resource per week',
    'ok', v_usage.minutes + v_minutes <= v_pol.max_minutes_per_week,
    'detail', round(v_usage.minutes / 60.0, 1) || ' h used, ' || round(v_minutes / 60.0, 1) || ' h requested');

  if v_pol.cooldown_hours > 0 then
    select max(returned_at) into v_last_ret from bookings
    where user_id = p_user and resource_id = p_res.id and returned_at is not null and id is distinct from p_exclude;
    v_checks := v_checks || jsonb_build_object('key', 'cooldown', 'group', 'fairness', 'label',
      v_pol.cooldown_hours || ' h gap after your last use',
      'ok', v_last_ret is null or p_start >= v_last_ret + make_interval(hours => v_pol.cooldown_hours),
      'detail', coalesce('Last returned ' || to_char(v_last_ret at time zone v_s.timezone, 'DD Mon HH24:MI'), 'No previous use'));
  end if;

  -- Blocked requests don't count: they are dead ends, replaced automatically by a new request
  v_dup := exists (select 1 from bookings b where b.user_id = p_user and b.resource_id = p_res.id
                   and b.id is distinct from p_exclude
                   and b.status in ('pending_review', 'waitlisted', 'approved', 'checked_in', 'overdue')
                   and b.during && tstzrange(p_start, p_end));
  v_checks := v_checks || jsonb_build_object('key', 'no_duplicate', 'group', 'fairness', 'label', 'No overlapping request of your own',
    'ok', not v_dup, 'detail', case when v_dup then 'You already have a request for this time' else 'OK' end);

  return v_checks;
end $$;

create or replace function _failed(p_checks jsonb) returns text
language sql immutable as $$
  select string_agg(c->>'label' || ' — ' || coalesce(c->>'detail', ''), '; ')
  from jsonb_array_elements(p_checks) c where (c->>'ok')::boolean is not true
$$;

-- Fair-allocation ranking for competing requests. Lower sort key wins.
-- Order: first-time users, then lowest use this week, then course-linked, then earliest.
create or replace function _rank_facts(p_booking bookings) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_first   boolean;
  v_usage   record;
  v_pol     fairness_policies;
  v_res     resources;
begin
  select * into v_res from resources where id = p_booking.resource_id;
  v_pol := _policy_for(v_res);
  v_first := not exists (select 1 from bookings b where b.user_id = p_booking.user_id and b.resource_id = p_booking.resource_id
                         and b.id <> p_booking.id and b.status in ('checked_in', 'returned', 'closed', 'disputed', 'overdue')
                         and lower(b.during) > now() - interval '180 days');
  select * into v_usage from _week_usage(p_booking.user_id, p_booking.resource_id, lower(p_booking.during), p_booking.id);
  return jsonb_build_object(
    'first_timer', v_first and v_pol.first_timer_priority,
    'week_minutes', v_usage.minutes,
    -- Priority only for a registered course in the student's own department
    'course_linked', exists (select 1 from courses c join profiles u on u.id = p_booking.user_id
                             where c.code = p_booking.course_code and c.active and c.department_id = u.department_id),
    'requested_at', p_booking.created_at);
end $$;

-- The competition picture for one booking: who else wants an overlapping slot,
-- their rank, and plain-language reasons. Identities of other students are hidden.
create or replace function _competition(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_b       bookings;
  v_rows    jsonb;
  v_me      jsonb;
  v_rank    int;
  v_total   int;
  v_reasons jsonb := '[]'::jsonb;
  v_top     jsonb;
begin
  select * into v_b from bookings where id = p_booking;
  if v_b.id is null then return null; end if;

  with c as (
    select b.id, b.status, _rank_facts(b) f
    from bookings b
    where b.resource_id = v_b.resource_id and b.during && v_b.during
      and b.status in ('pending_review', 'waitlisted')
  ), r as (
    select id, status, f,
           row_number() over (order by (f->>'first_timer')::boolean desc, (f->>'week_minutes')::int asc,
                                       (f->>'course_linked')::boolean desc, (f->>'requested_at')::timestamptz asc) rn
    from c
  )
  select jsonb_agg(jsonb_build_object('booking_id', id, 'status', status, 'rank', rn, 'facts', f) order by rn), count(*)
    into v_rows, v_total from r;

  if v_total is null or v_total = 0 then
    return jsonb_build_object('competing', 0);
  end if;
  select (e->>'rank')::int, e->'facts' into v_rank, v_me from jsonb_array_elements(v_rows) e where (e->>'booking_id')::uuid = p_booking;
  select e->'facts' into v_top from jsonb_array_elements(v_rows) e where (e->>'rank')::int = 1;

  if v_me is not null then
    v_reasons := v_reasons || to_jsonb(case when (v_me->>'first_timer')::boolean
      then 'First use of this resource in the last 6 months (priority)' else 'Has used this resource recently' end);
    v_reasons := v_reasons || to_jsonb(round((v_me->>'week_minutes')::numeric / 60, 1) || ' h of this resource used this week');
    if (v_me->>'course_linked')::boolean then v_reasons := v_reasons || to_jsonb('Linked to a course'::text); end if;
  end if;

  return jsonb_build_object(
    'competing', v_total,
    'rank', v_rank,
    'rule', 'First-time users first, then least use this week, then course-linked, then earliest request',
    'reasons', v_reasons,
    'queue', v_rows);
end $$;

-- ===========================================================================
-- 6. Booking RPCs
-- ===========================================================================

-- Preview: runs every check without saving anything. The request screen calls
-- this as the user changes the slot, so they see exactly what will happen.
create or replace function preview_booking(p_resource uuid, p_start timestamptz, p_end timestamptz,
                                           p_quantity int default 1, p_course text default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_res    resources;
  v_checks jsonb;
  v_free   boolean;
  v_comp   int;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_res from resources where id = p_resource;
  if v_res.id is null or (v_res.status <> 'active' and not can_manage_resource(p_resource)) then
    raise exception 'Resource not found' using errcode = 'P0002';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'End must be after start' using errcode = '22023';
  end if;
  v_checks := _booking_checks(auth.uid(), v_res, p_start, p_end, coalesce(p_quantity, 1), _norm_course(p_course), null);
  v_free := _slot_free(v_res, p_start, p_end, coalesce(p_quantity, 1), null);
  select count(*) into v_comp from bookings b
  where b.resource_id = p_resource and b.status in ('pending_review', 'waitlisted') and b.during && tstzrange(p_start, p_end);
  return jsonb_build_object(
    'checks', v_checks,
    'all_passed', _failed(v_checks) is null,
    'slot_free', v_free,
    'competing_requests', v_comp,
    'outcome', case when _failed(v_checks) is not null then 'blocked' when v_free then 'pending_review' else 'waitlisted' end);
end $$;

create or replace function request_booking(p_resource uuid, p_start timestamptz, p_end timestamptz,
                                           p_quantity int, p_purpose text, p_course text default null,
                                           p_deposit_ack boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res     resources;
  v_checks  jsonb;
  v_failed  text;
  v_status  booking_status;
  v_free    boolean;
  v_course  text := _norm_course(p_course);
  v_id      uuid;
  v_recent  int;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;

  -- Rate limit: 10 requests per user per hour stops scripted spamming of the queue.
  -- The per-user lock makes parallel calls queue up so the count can't be raced.
  perform pg_advisory_xact_lock(hashtext('request:' || auth.uid()::text));
  select count(*) into v_recent from bookings where user_id = auth.uid() and created_at > now() - interval '1 hour';
  if v_recent >= 10 then raise exception 'Too many requests in the last hour. Try again later.' using errcode = '54000'; end if;

  -- Lock the resource row so two requests for the same slot are decided one after the other
  select * into v_res from resources where id = p_resource for update;
  if v_res.id is null or (v_res.status <> 'active' and not can_manage_resource(p_resource)) then
    raise exception 'Resource not found' using errcode = 'P0002';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'End must be after start' using errcode = '22023';
  end if;
  if p_purpose is null or length(btrim(p_purpose)) < 10 then
    raise exception 'Describe the purpose in at least 10 characters' using errcode = '22023';
  end if;
  if v_course is not null and v_course !~ '^[A-Z]{2,4}-[0-9]{3}$' then
    raise exception 'Course codes look like ECE-304' using errcode = '22023';
  end if;
  if length(v_res.deposit_note) > 0 and not coalesce(p_deposit_ack, false) then
    raise exception 'Acknowledge the deposit and usage conditions first' using errcode = '22023';
  end if;

  v_checks := _booking_checks(auth.uid(), v_res, p_start, p_end, coalesce(p_quantity, 1), v_course, null);
  v_failed := _failed(v_checks);

  if v_failed is not null then
    v_status := 'blocked';
  else
    v_free := _slot_free(v_res, p_start, p_end, coalesce(p_quantity, 1), null);
    v_status := case when v_free then 'pending_review' else 'waitlisted' end;
  end if;

  insert into bookings (resource_id, user_id, during, quantity, pooled, purpose, course_code, deposit_acknowledged,
                        status, decision_reason, allocation_explanation)
  values (v_res.id, auth.uid(), tstzrange(p_start, p_end), coalesce(p_quantity, 1), v_res.quantity > 1,
          btrim(p_purpose), v_course, coalesce(p_deposit_ack, false), v_status,
          case v_status
            when 'blocked' then 'Automatic checks failed: ' || v_failed
            when 'waitlisted' then 'The slot is already allocated. You are on the waitlist and will move up automatically if it frees.'
            else 'All automatic checks passed; waiting for owner review.' end,
          jsonb_build_object('checks', v_checks, 'slot_free', v_free, 'evaluated_at', now()))
  returning id into v_id;

  -- A new request replaces the requester's own earlier blocked request for an overlapping time
  if v_status <> 'blocked' then
    perform _set_context('replaced', 'Replaced by a newer request for the same time');
    update bookings set status = 'cancelled', decision_reason = 'Replaced by a newer request for the same time'
    where user_id = auth.uid() and resource_id = v_res.id and status = 'blocked' and id <> v_id
      and during && tstzrange(p_start, p_end);
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status, 'competition', _competition(v_id) - 'queue');
end $$;

-- Move waitlisted requests into review when capacity frees up, best-ranked first.
create or replace function _promote_waitlist(p_resource uuid, p_range tstzrange) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res   resources;
  v_b     bookings;
  v_n     int := 0;
  v_checks jsonb;
begin
  select * into v_res from resources where id = p_resource;
  for v_b in
    select b.* from bookings b
    where b.resource_id = p_resource and b.status = 'waitlisted' and b.during && p_range and lower(b.during) > now()
    order by ((_rank_facts(b))->>'first_timer')::boolean desc, ((_rank_facts(b))->>'week_minutes')::int asc,
             ((_rank_facts(b))->>'course_linked')::boolean desc, b.created_at asc
  loop
    if _slot_free(v_res, lower(v_b.during), upper(v_b.during), v_b.quantity, v_b.id)
       and not exists (select 1 from bookings o where o.resource_id = p_resource and o.id <> v_b.id
                       and o.status = 'pending_review' and o.during && v_b.during and v_res.quantity = 1) then
      v_checks := _booking_checks(v_b.user_id, v_res, lower(v_b.during), upper(v_b.during), v_b.quantity, v_b.course_code, v_b.id);
      -- The notice-period check is ignored on promotion: the user asked in time originally
      if _failed((select jsonb_agg(c) from jsonb_array_elements(v_checks) c where c->>'key' <> 'notice')) is null then
        perform _set_context('waitlist_promoted', 'A slot opened up. Your request moved from the waitlist back to owner review.');
        update bookings set status = 'pending_review',
               decision_reason = 'A slot opened up. Your request moved from the waitlist back to owner review.',
               allocation_explanation = allocation_explanation || jsonb_build_object('promoted_at', now())
        where id = v_b.id;
        v_n := v_n + 1;
      end if;
    end if;
  end loop;
  return v_n;
end $$;

create or replace function decide_booking(p_booking uuid, p_decision text, p_reason text, p_override boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b      bookings;
  v_res    resources;
  v_reason text;
  v_checks jsonb;
  v_failed text;
  v_bumped int := 0;
  v_other  bookings;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_b from bookings where id = p_booking for update;
  if v_b.id is null or not can_manage_resource(v_b.resource_id) then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  if v_b.user_id = auth.uid() then
    raise exception 'You cannot decide on your own request; another manager must review it' using errcode = '42501';
  end if;
  if p_decision not in ('approve', 'reject', 'waitlist') then
    raise exception 'Decision must be approve, reject or waitlist' using errcode = '22023';
  end if;
  v_reason := _require_reason(p_reason);
  select * into v_res from resources where id = v_b.resource_id for update;

  if p_decision = 'approve' then
    if v_b.status not in ('pending_review', 'waitlisted', 'blocked') then
      raise exception 'Only requests in review, on the waitlist or blocked can be approved (this one is %)', v_b.status using errcode = '22023';
    end if;
    if lower(v_b.during) + make_interval(mins => (_settings()).no_show_grace_minutes) <= now() then
      raise exception 'This slot started too long ago to check in; ask the student to pick a new time' using errcode = '22023';
    end if;
    v_checks := _booking_checks(v_b.user_id, v_res, lower(v_b.during), upper(v_b.during), v_b.quantity, v_b.course_code, v_b.id);
    v_failed := _failed((select jsonb_agg(c) from jsonb_array_elements(v_checks) c where c->>'key' <> 'notice'));
    if v_failed is not null then
      if not (p_override and is_manager_of(v_res.department_id)) then
        raise exception 'Requirements are not met: %. A manager can approve with an override and a reason.', v_failed using errcode = '22023';
      end if;
    end if;
    if not _slot_free(v_res, lower(v_b.during), upper(v_b.during), v_b.quantity, v_b.id) then
      raise exception 'That slot is no longer free; waitlist or reject this request instead' using errcode = '23P01';
    end if;
    perform _set_context(case when v_failed is not null then 'override_approved' else 'approved' end, v_reason);
    update bookings set status = 'approved', decision_reason = v_reason, decided_by = auth.uid(), decided_at = now(),
           allocation_explanation = allocation_explanation || jsonb_build_object(
             'decision_checks', v_checks, 'override', v_failed is not null, 'competition_at_decision', _competition(v_b.id))
    where id = v_b.id;

    -- Competing requests that no longer fit go to the waitlist (never rejected automatically)
    for v_other in
      select * from bookings o where o.resource_id = v_b.resource_id and o.id <> v_b.id
        and o.status = 'pending_review' and o.during && v_b.during
    loop
      if not _slot_free(v_res, lower(v_other.during), upper(v_other.during), v_other.quantity, v_other.id) then
        perform _set_context('waitlisted_by_allocation',
          'The overlapping slot was allocated to another request under the fair-allocation rule. You stay first in line if it frees.');
        update bookings set status = 'waitlisted',
               decision_reason = 'The overlapping slot was allocated to another request under the fair-allocation rule. You stay in line if it frees.'
        where id = v_other.id;
        v_bumped := v_bumped + 1;
      end if;
    end loop;

  elsif p_decision = 'reject' then
    if v_b.status not in ('pending_review', 'waitlisted', 'blocked') then
      raise exception 'Only open requests can be rejected (this one is %)', v_b.status using errcode = '22023';
    end if;
    perform _set_context('rejected', v_reason);
    update bookings set status = 'rejected', decision_reason = v_reason, decided_by = auth.uid(), decided_at = now()
    where id = v_b.id;

  else -- waitlist
    if v_b.status <> 'pending_review' then
      raise exception 'Only requests in review can be waitlisted (this one is %)', v_b.status using errcode = '22023';
    end if;
    perform _set_context('waitlisted', v_reason);
    update bookings set status = 'waitlisted', decision_reason = v_reason, decided_by = auth.uid(), decided_at = now()
    where id = v_b.id;
  end if;

  return jsonb_build_object('id', v_b.id, 'status', (select status from bookings where id = v_b.id), 'moved_to_waitlist', v_bumped);
end $$;

create or replace function cancel_booking(p_booking uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b       bookings;
  v_reason  text;
  v_is_user boolean;
  v_promoted int := 0;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_b from bookings where id = p_booking for update;
  if v_b.id is null or not can_view_booking(p_booking) then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  v_is_user := v_b.user_id = auth.uid();
  if v_b.status not in ('pending_review', 'waitlisted', 'approved', 'blocked') then
    raise exception 'A booking that is % cannot be cancelled', v_b.status using errcode = '22023';
  end if;
  if v_is_user and v_b.status = 'approved' and now() >= lower(v_b.during) then
    raise exception 'The slot has started. Check in, or ask the owner to cancel it' using errcode = '22023';
  end if;
  v_reason := case when v_is_user then coalesce(nullif(btrim(p_reason), ''), 'Cancelled by the requester')
                   else _require_reason(p_reason) end;
  perform _set_context(case when v_is_user then 'cancelled_by_user' else 'cancelled_by_owner' end, v_reason);
  update bookings set status = 'cancelled', decision_reason = v_reason,
         decided_by = case when v_is_user then decided_by else auth.uid() end,
         decided_at = case when v_is_user then decided_at else now() end
  where id = v_b.id;
  if v_b.status = 'approved' then
    v_promoted := _promote_waitlist(v_b.resource_id, v_b.during);
  end if;
  return jsonb_build_object('id', v_b.id, 'status', 'cancelled', 'promoted_from_waitlist', v_promoted);
end $$;

create or replace function check_in(p_booking uuid, p_checklist jsonb, p_photos text[], p_notes text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b bookings;
  v_s app_settings := _settings();
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_b from bookings where id = p_booking for update;
  if v_b.id is null or v_b.user_id <> auth.uid() then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  if v_b.status <> 'approved' then
    raise exception 'Only an approved booking can be checked in (this one is %)', v_b.status using errcode = '22023';
  end if;
  if now() < lower(v_b.during) - make_interval(mins => v_s.early_checkin_minutes) then
    raise exception 'Check-in opens % minutes before the slot starts', v_s.early_checkin_minutes using errcode = '22023';
  end if;
  if now() >= upper(v_b.during) then
    raise exception 'This slot has ended' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_photos), 0) < 1 then
    raise exception 'Add at least one photo of the condition' using errcode = '22023';
  end if;
  perform _assert_own_paths(p_photos, p_booking, 'condition-photos');

  insert into condition_records (booking_id, phase, checklist, photo_paths, notes, recorded_by)
  values (p_booking, 'checkin', _clean_checklist(p_booking, p_checklist), p_photos, left(coalesce(p_notes, ''), 2000), auth.uid());
  perform _set_context('checked_in', nullif(btrim(coalesce(p_notes, '')), ''));
  update bookings set status = 'checked_in', checked_in_at = now() where id = p_booking;
  return jsonb_build_object('id', p_booking, 'status', 'checked_in');
end $$;

create or replace function return_booking(p_booking uuid, p_checklist jsonb, p_photos text[], p_notes text default '')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_b bookings;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_b from bookings where id = p_booking for update;
  if v_b.id is null or v_b.user_id <> auth.uid() then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  if v_b.status not in ('checked_in', 'overdue') then
    raise exception 'Only a checked-in booking can be returned (this one is %)', v_b.status using errcode = '22023';
  end if;
  if coalesce(cardinality(p_photos), 0) < 1 then
    raise exception 'Add at least one photo of the condition' using errcode = '22023';
  end if;
  perform _assert_own_paths(p_photos, p_booking, 'condition-photos');

  insert into condition_records (booking_id, phase, checklist, photo_paths, notes, recorded_by)
  values (p_booking, 'return', _clean_checklist(p_booking, p_checklist), p_photos, left(coalesce(p_notes, ''), 2000), auth.uid());
  perform _set_context(case when v_b.status = 'overdue' then 'returned_late' else 'returned' end,
                       nullif(btrim(coalesce(p_notes, '')), ''));
  update bookings set status = 'returned', returned_at = now() where id = p_booking;
  return jsonb_build_object('id', p_booking, 'status', 'returned');
end $$;

-- Owner confirms the item came back as recorded. Countersigns both records.
create or replace function confirm_return(p_booking uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_b bookings;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_b from bookings where id = p_booking for update;
  if v_b.id is null or not can_manage_resource(v_b.resource_id) then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  if v_b.user_id = auth.uid() then
    raise exception 'Another person must confirm the return of your own booking' using errcode = '42501';
  end if;
  if v_b.status <> 'returned' then
    raise exception 'Only a returned booking can be confirmed (this one is %)', v_b.status using errcode = '22023';
  end if;
  if exists (select 1 from incidents where booking_id = p_booking and status <> 'resolved') then
    raise exception 'Resolve the open incident before closing' using errcode = '22023';
  end if;
  update condition_records set countersigned_by = auth.uid(), countersigned_at = now()
  where booking_id = p_booking and countersigned_by is null;
  perform _set_context('return_confirmed', coalesce(nullif(btrim(p_note), ''), 'Condition matches the return record'));
  update bookings set status = 'closed', closed_at = now(),
         decision_reason = coalesce(nullif(btrim(p_note), ''), 'Condition matches the return record')
  where id = p_booking;
  return jsonb_build_object('id', p_booking, 'status', 'closed');
end $$;

-- ===========================================================================
-- 7. Incidents
-- ===========================================================================

create or replace function report_incident(p_booking uuid, p_type incident_type, p_severity incident_severity,
                                           p_description text, p_photos text[] default '{}', p_estimated_cost numeric default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b  bookings;
  v_s  app_settings := _settings();
  v_id uuid;
  v_res resources;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_b from bookings where id = p_booking for update;
  if v_b.id is null or not can_view_booking(p_booking) then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  if v_b.status not in ('approved', 'checked_in', 'overdue', 'returned', 'closed', 'disputed', 'no_show') then
    raise exception 'Incidents can be reported once a booking has been approved' using errcode = '22023';
  end if;
  if v_b.status = 'closed' and v_b.closed_at < now() - make_interval(days => v_s.dispute_window_days) then
    raise exception 'The % day window for reporting on a closed booking has passed', v_s.dispute_window_days using errcode = '22023';
  end if;
  if p_description is null or length(btrim(p_description)) < 10 then
    raise exception 'Describe what happened in at least 10 characters' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('incident:' || auth.uid()::text));
  if (select count(*) from incidents where reported_by = auth.uid() and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many reports in the last hour' using errcode = '54000';
  end if;
  perform _assert_own_paths(p_photos, p_booking, 'incident-photos');

  insert into incidents (booking_id, reported_by, type, severity, description, photo_paths, estimated_cost)
  values (p_booking, auth.uid(), p_type, p_severity, btrim(p_description), coalesce(p_photos, '{}'), p_estimated_cost)
  returning id into v_id;

  select * into v_res from resources where id = v_b.resource_id;
  if v_b.status in ('returned', 'closed') then
    perform _set_context('incident_opened', left(btrim(p_description), 300));
    update bookings set status = 'disputed' where id = p_booking;
  else
    -- Status stays, but both sides and the managers are told
    perform _notify_managers(v_b.resource_id, 'incident_reported', 'Incident on ' || v_res.name, left(btrim(p_description), 300), p_booking);
    if v_b.user_id <> auth.uid() then
      perform _notify(v_b.user_id, 'incident_reported', 'Incident on ' || v_res.name, left(btrim(p_description), 300), p_booking);
    end if;
  end if;
  return jsonb_build_object('id', v_id, 'booking_status', (select status from bookings where id = p_booking));
end $$;

create or replace function review_incident(p_incident uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_i incidents; v_dept uuid;
begin
  select i.* into v_i from incidents i where i.id = p_incident for update;
  select r.department_id into v_dept from bookings b join resources r on r.id = b.resource_id where b.id = v_i.booking_id;
  if v_i.id is null or not is_manager_of(v_dept) then
    raise exception 'Incident not found' using errcode = 'P0002';
  end if;
  if v_i.status <> 'open' then raise exception 'Incident is already %', v_i.status using errcode = '22023'; end if;
  perform _set_context('incident_under_review', 'A manager is reviewing this incident');
  update incidents set status = 'under_review' where id = p_incident;
  return jsonb_build_object('id', p_incident, 'status', 'under_review');
end $$;

-- Only a manager or admin resolves. A strike is a human decision, recorded with its reason.
create or replace function resolve_incident(p_incident uuid, p_resolution text, p_apply_strike boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_i      incidents;
  v_b      bookings;
  v_res    resources;
  v_reason text;
  v_s      app_settings := _settings();
  v_pol    fairness_policies;
  v_strikes int;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_i from incidents where id = p_incident for update;
  select * into v_b from bookings where id = v_i.booking_id for update;
  select * into v_res from resources where id = v_b.resource_id;
  if v_i.id is null or not is_manager_of(v_res.department_id) then
    raise exception 'Incident not found' using errcode = 'P0002';
  end if;
  if v_b.user_id = auth.uid() then
    raise exception 'You cannot resolve an incident on your own booking' using errcode = '42501';
  end if;
  if v_i.status = 'resolved' then raise exception 'Incident is already resolved' using errcode = '22023'; end if;
  v_reason := _require_reason(p_resolution, 10);

  perform _set_context('incident_resolved', v_reason);
  update incidents set status = 'resolved', resolution = v_reason, resolved_by = auth.uid(), resolved_at = now(),
         strike_applied = coalesce(p_apply_strike, false)
  where id = p_incident;

  if coalesce(p_apply_strike, false) then
    v_pol := _policy_for(v_res);
    perform _set_context('strike_applied', 'Strike from incident: ' || v_reason);
    -- Reaching the limit turns the strikes into a suspension; the count starts again afterwards
    update profiles set
           suspended_until = case when strikes + 1 >= v_pol.max_open_strikes
                                  then now() + make_interval(days => v_s.suspension_days) else suspended_until end,
           strikes = case when strikes + 1 >= v_pol.max_open_strikes then 0 else strikes + 1 end
    where id = v_b.user_id
    returning strikes into v_strikes;
    if v_strikes = 0 then
      perform _notify(v_b.user_id, 'suspended', 'Booking suspended for ' || v_s.suspension_days || ' days',
        v_reason || ' This strike reached the limit of ' || v_pol.max_open_strikes || '.', v_b.id);
    else
      perform _notify(v_b.user_id, 'strike', 'A strike was recorded on your account',
        v_reason || ' (' || v_strikes || ' of ' || v_pol.max_open_strikes || ')', v_b.id);
    end if;
  end if;

  perform _notify(v_b.user_id, 'incident_resolved', 'Incident resolved: ' || v_res.name, v_reason, v_b.id);
  perform _notify(v_res.owner_id, 'incident_resolved', 'Incident resolved: ' || v_res.name, v_reason, v_b.id);

  if v_b.status = 'disputed' and not exists (select 1 from incidents where booking_id = v_b.id and status <> 'resolved') then
    perform _set_context('dispute_closed', v_reason);
    update condition_records set countersigned_by = auth.uid(), countersigned_at = now()
    where booking_id = v_b.id and countersigned_by is null;
    update bookings set status = 'closed', closed_at = now(), decision_reason = v_reason where id = v_b.id;
  end if;
  return jsonb_build_object('id', p_incident, 'status', 'resolved', 'booking_status', (select status from bookings where id = v_b.id));
end $$;

-- ===========================================================================
-- 8. Time-based sweep: no-shows, overdue returns. Idempotent; safe to call often.
-- ===========================================================================

create or replace function sweep_due() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_s   app_settings := _settings();
  v_b   bookings;
  v_ns  int := 0;
  v_od  int := 0;
begin
  for v_b in select * from bookings where status = 'approved'
               and greatest(lower(during), coalesce(decided_at, lower(during))) + make_interval(mins => v_s.no_show_grace_minutes) < now()
             for update skip locked loop
    perform _set_context('no_show', 'No check-in within ' || v_s.no_show_grace_minutes || ' minutes of the start time');
    update bookings set status = 'no_show',
           decision_reason = 'No check-in within ' || v_s.no_show_grace_minutes || ' minutes of the start time'
    where id = v_b.id;
    -- Opens an incident for a person to judge; the system never applies the strike itself
    insert into incidents (booking_id, reported_by, type, severity, description)
    values (v_b.id, (select owner_id from resources where id = v_b.resource_id), 'delay', 'low',
            'Automatic: no check-in recorded within ' || v_s.no_show_grace_minutes || ' minutes of the slot start. A manager decides whether a strike applies.');
    perform _promote_waitlist(v_b.resource_id, v_b.during);
    v_ns := v_ns + 1;
  end loop;

  for v_b in select * from bookings where status = 'checked_in' and upper(during) < now()
             for update skip locked loop
    perform _set_context('overdue', 'Return time passed without a return record');
    update bookings set status = 'overdue', decision_reason = 'Return time passed without a return record' where id = v_b.id;
    insert into incidents (booking_id, reported_by, type, severity, description)
    values (v_b.id, (select owner_id from resources where id = v_b.resource_id), 'delay', 'medium',
            'Automatic: the return time passed and no return has been recorded yet.');
    v_od := v_od + 1;
  end loop;

  return jsonb_build_object('no_show', v_ns, 'overdue', v_od, 'at', now());
end $$;

-- ===========================================================================
-- 9. Verification and administration
-- ===========================================================================

create or replace function verify_profile(p_user uuid, p_status verification_status, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_target profiles;
begin
  select * into v_target from profiles where id = p_user for update;
  if v_target.id is null or not (is_admin() or (v_target.department_id is not null and is_manager_of(v_target.department_id))) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  if p_user = auth.uid() then raise exception 'You cannot verify yourself' using errcode = '42501'; end if;
  if v_target.role in ('manager', 'admin') and not is_admin() then
    raise exception 'Only an admin can verify managers and admins' using errcode = '42501';
  end if;
  perform _set_context('profile_' || p_status::text, _require_reason(p_reason, 3));
  update profiles set verification_status = p_status,
         verified_by = case when p_status = 'verified' then auth.uid() end,
         verified_at = case when p_status = 'verified' then now() end
  where id = p_user;
  perform _notify(p_user, 'account_' || p_status::text, 'Account ' || p_status::text, btrim(p_reason), null);
  return jsonb_build_object('id', p_user, 'verification_status', p_status);
end $$;

create or replace function set_user_role(p_user uuid, p_role user_role, p_department uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_admin() then raise exception 'Only an admin can change roles' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'You cannot change your own role' using errcode = '42501'; end if;
  if p_role = 'manager' and p_department is null then
    raise exception 'A manager needs a department' using errcode = '22023';
  end if;
  perform _set_context('role_changed', _require_reason(p_reason, 3));
  update profiles set role = p_role, department_id = coalesce(p_department, department_id) where id = p_user;
  if not found then raise exception 'User not found' using errcode = 'P0002'; end if;
  perform _notify(p_user, 'role_changed', 'Your role is now ' || p_role::text, btrim(p_reason), null);
  return jsonb_build_object('id', p_user, 'role', p_role);
end $$;

create or replace function clear_strikes(p_user uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_dept uuid;
begin
  select department_id into v_dept from profiles where id = p_user;
  if not (is_admin() or (v_dept is not null and is_manager_of(v_dept))) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  if p_user = auth.uid() then raise exception 'You cannot clear your own strikes' using errcode = '42501'; end if;
  perform _set_context('strikes_cleared', _require_reason(p_reason));
  update profiles set strikes = 0, suspended_until = null where id = p_user;
  perform _notify(p_user, 'strikes_cleared', 'Your strikes were cleared', btrim(p_reason), null);
  return jsonb_build_object('id', p_user, 'strikes', 0);
end $$;

-- Who may verify a training certificate: admins, managers of the user's
-- department, or the verified owner of an active resource that requires it.
-- Who may verify a training certificate: admins, managers of the department that runs
-- the training, or a verified owner in that department who owns an active resource
-- requiring it. Being the student's own manager is not enough: only the department that
-- runs an induction can vouch that someone attended it. Adding a tag to your own
-- listing does not make you a verifier for another department's training.
create or replace function _can_verify_qualification(p_q user_qualifications) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_q.user_id <> auth.uid() and (
    is_admin()
    or is_manager_of((select department_id from training_tags where tag = p_q.training_tag))
    or exists (select 1 from training_tags t
               join resource_requirements rr on rr.type = 'training' and rr.value = t.tag
               join resources r on r.id = rr.resource_id
               join profiles me on me.id = auth.uid()
               where t.tag = p_q.training_tag and t.department_id = me.department_id
                 and r.owner_id = auth.uid() and r.department_id = t.department_id
                 and r.status in ('active', 'maintenance') and me.verification_status = 'verified'))
$$;

create or replace function verify_qualification(p_id uuid, p_status qualification_status, p_reason text, p_expires date default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_q user_qualifications;
begin
  select * into v_q from user_qualifications where id = p_id for update;
  if v_q.id is null or not _can_verify_qualification(v_q) then
    raise exception 'Qualification not found' using errcode = 'P0002';
  end if;
  if p_status not in ('verified', 'rejected') then
    raise exception 'Status must be verified or rejected' using errcode = '22023';
  end if;
  if v_q.status <> 'pending' and not (is_admin() or is_manager_of((select department_id from training_tags where tag = v_q.training_tag))) then
    raise exception 'This certificate was already decided; only a department manager can change it' using errcode = '42501';
  end if;
  if p_status = 'verified' and v_q.evidence_path is null then
    raise exception 'There is no certificate to verify' using errcode = '22023';
  end if;
  if p_expires is not null and p_expires < current_date then
    raise exception 'Expiry date is in the past' using errcode = '22023';
  end if;
  perform _set_context('qualification_' || p_status::text, _require_reason(p_reason, 3));
  update user_qualifications set status = p_status, decision_reason = btrim(p_reason),
         verified_by = auth.uid(), verified_at = now(),
         expires_at = case when p_status = 'verified' then p_expires else expires_at end
  where id = p_id;
  return jsonb_build_object('id', p_id, 'status', p_status);
end $$;

create or replace function mark_notifications_read(p_ids uuid[] default null)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ===========================================================================
-- 10. Read RPCs: one call per screen, permissions applied inside
-- ===========================================================================

create or replace function list_resources(p_query text default null, p_category text default null,
                                          p_department uuid default null, p_kind resource_kind default null,
                                          p_eligible_only boolean default false, p_mine boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_out jsonb; v_q text := nullif(btrim(left(coalesce(p_query, ''), 80)), '');
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  with base as (
    select r.*, d.code as dept_code, d.name as dept_name,
           _eligibility(auth.uid(), r.id) as elig
    from resources r join departments d on d.id = r.department_id
    where (r.status = 'active' or can_manage_resource(r.id))
      and (not p_mine or can_manage_resource(r.id))
      and (p_category is null or r.category = p_category)
      and (p_department is null or r.department_id = p_department)
      and (p_kind is null or r.kind = p_kind)
      and (v_q is null
           or to_tsvector('english', r.name || ' ' || r.category || ' ' || r.description) @@ websearch_to_tsquery('english', v_q)
           or r.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%'
           or r.location ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'kind', b.kind, 'category', b.category, 'location', b.location,
      'status', b.status, 'quantity', b.quantity, 'photo_url', b.photo_urls[1],
      'department', jsonb_build_object('id', b.department_id, 'code', b.dept_code, 'name', b.dept_name),
      'owner', _person_card(b.owner_id),
      'requirements', (select coalesce(jsonb_agg(e->>'label'), '[]'::jsonb) from jsonb_array_elements(b.elig) e),
      'eligible', not exists (select 1 from jsonb_array_elements(b.elig) e where (e->>'ok')::boolean is not true),
      'requires_supervision', b.requires_supervision,
      'pending_requests', (select count(*) from bookings x where x.resource_id = b.id and x.status in ('pending_review', 'waitlisted')),
      'busy_now', exists (select 1 from bookings x where x.resource_id = b.id and x.status in ('checked_in', 'overdue') and x.during @> now()),
      'manageable', can_manage_resource(b.id)
    ) order by b.name), '[]'::jsonb)
  into v_out
  from base b
  where not p_eligible_only or not exists (select 1 from jsonb_array_elements(b.elig) e where (e->>'ok')::boolean is not true);
  return v_out;
end $$;

create or replace function get_resource(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_r resources; v_manage boolean;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_r from resources where id = p_id;
  v_manage := can_manage_resource(p_id);
  if v_r.id is null or (v_r.status <> 'active' and not v_manage) then
    raise exception 'Resource not found' using errcode = 'P0002';
  end if;
  return to_jsonb(v_r) || jsonb_build_object(
    'department', (select jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name) from departments d where d.id = v_r.department_id),
    'owner', _person_card(v_r.owner_id),
    'requirements', (select coalesce(jsonb_agg(to_jsonb(rr) order by rr.type), '[]'::jsonb) from resource_requirements rr where rr.resource_id = p_id),
    'availability', (select coalesce(jsonb_agg(to_jsonb(a) order by a.weekday nulls last, a.opens_at, a.blackout_date), '[]'::jsonb) from availability_rules a where a.resource_id = p_id),
    'policy', to_jsonb(_policy_for(v_r)),
    'eligibility', _eligibility(auth.uid(), p_id),
    'my_week', (select to_jsonb(u) from _week_usage(auth.uid(), p_id, now(), null) u),
    -- Busy slots for the next 21 days, without revealing who holds them
    'busy', (select coalesce(jsonb_agg(jsonb_build_object('start', lower(b.during), 'end', upper(b.during),
                     'quantity', b.quantity, 'mine', b.user_id = auth.uid()) order by lower(b.during)), '[]'::jsonb)
             from bookings b where b.resource_id = p_id and b.status in ('approved', 'checked_in', 'overdue')
               and upper(b.during) > now() and lower(b.during) < now() + interval '21 days'),
    'my_bookings', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'status', b.status, 'start', lower(b.during), 'end', upper(b.during)) order by lower(b.during) desc), '[]'::jsonb)
                    from (select * from bookings x where x.resource_id = p_id and x.user_id = auth.uid()
                          order by lower(x.during) desc limit 10) b),
    'manageable', v_manage);
end $$;

create or replace function _booking_summary(b bookings) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', b.id, 'status', b.status, 'start', lower(b.during), 'end', upper(b.during),
    'quantity', b.quantity, 'purpose', b.purpose, 'course_code', b.course_code,
    'decision_reason', b.decision_reason, 'decided_at', b.decided_at, 'created_at', b.created_at,
    'resource', (select jsonb_build_object('id', r.id, 'name', r.name, 'location', r.location, 'category', r.category,
                                           'kind', r.kind, 'photo_url', r.photo_urls[1]) from resources r where r.id = b.resource_id),
    'user', _person_card(b.user_id),
    'open_incidents', (select count(*) from incidents i where i.booking_id = b.id and i.status <> 'resolved'))
$$;

create or replace function my_bookings() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(_booking_summary(b) || jsonb_build_object(
            'competition', case when b.status in ('pending_review', 'waitlisted') then _competition(b.id) - 'queue' end)
          order by lower(b.during) desc), '[]'::jsonb)
          from bookings b where b.user_id = auth.uid());
end $$;

create or replace function get_booking(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_b bookings; v_manage boolean; v_comp jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into v_b from bookings where id = p_id;
  if v_b.id is null or not can_view_booking(p_id) then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  v_manage := can_manage_resource(v_b.resource_id);
  v_comp := case when v_b.status in ('pending_review', 'waitlisted', 'blocked') then _competition(p_id) end;
  -- A student sees their own rank, not the other students' booking ids
  if v_comp is not null and not v_manage then
    v_comp := v_comp - 'queue';
  end if;
  return _booking_summary(v_b) || jsonb_build_object(
    'checks', v_b.allocation_explanation->'checks',
    'decision_checks', v_b.allocation_explanation->'decision_checks',
    'override', coalesce((v_b.allocation_explanation->>'override')::boolean, false),
    'competition', v_comp,
    'ai_brief', case when v_manage then v_b.ai_brief end,
    'decided_by', _person_card(v_b.decided_by),
    'owner', (select _person_card(r.owner_id) from resources r where r.id = v_b.resource_id),
    'checklist_template', (select r.checklist_template from resources r where r.id = v_b.resource_id),
    'checked_in_at', v_b.checked_in_at, 'returned_at', v_b.returned_at, 'closed_at', v_b.closed_at,
    'deposit_acknowledged', v_b.deposit_acknowledged,
    'records', (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('recorded_by_card', _person_card(c.recorded_by)) order by c.recorded_at), '[]'::jsonb)
                from condition_records c where c.booking_id = p_id),
    'incidents', (select coalesce(jsonb_agg(to_jsonb(i) - 'ai_summary' || jsonb_build_object(
                     'reported_by_card', _person_card(i.reported_by), 'resolved_by_card', _person_card(i.resolved_by),
                     'ai_summary', case when v_manage then i.ai_summary end) order by i.created_at), '[]'::jsonb)
                  from incidents i where i.booking_id = p_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('at', a.created_at, 'action', a.action, 'from', a.from_state,
                     'to', a.to_state, 'reason', a.reason, 'actor', _person_card(a.actor_id), 'actor_role', a.actor_role) order by a.id), '[]'::jsonb)
                from audit_log a where (a.entity = 'booking' and a.entity_id = p_id)
                   or (a.entity = 'incident' and a.entity_id in (select id from incidents where booking_id = p_id))),
    'can', jsonb_build_object(
      'decide', v_manage and v_b.user_id <> auth.uid() and v_b.status in ('pending_review', 'waitlisted', 'blocked'),
      'cancel', v_b.status in ('pending_review', 'waitlisted', 'approved', 'blocked'),
      'check_in', v_b.user_id = auth.uid() and v_b.status = 'approved'
                  and now() >= lower(v_b.during) - make_interval(mins => (_settings()).early_checkin_minutes) and now() < upper(v_b.during),
      'return', v_b.user_id = auth.uid() and v_b.status in ('checked_in', 'overdue'),
      'confirm_return', v_manage and v_b.user_id <> auth.uid() and v_b.status = 'returned'
                        and not exists (select 1 from incidents i where i.booking_id = p_id and i.status <> 'resolved'),
      'report_incident', v_b.status in ('approved', 'checked_in', 'overdue', 'returned', 'closed', 'disputed', 'no_show'),
      'manage', v_manage));
end $$;

create or replace function review_queue() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  return jsonb_build_object(
    'requests', (select coalesce(jsonb_agg(_booking_summary(b) || jsonb_build_object(
                    'checks', b.allocation_explanation->'checks',
                    'competition', _competition(b.id),
                    'ai_brief', b.ai_brief,
                    'user_week', (select to_jsonb(u) from _week_usage(b.user_id, b.resource_id, lower(b.during), b.id) u),
                    'user_strikes', (select strikes from profiles where id = b.user_id),
                    'user_history', (select count(*) from bookings h where h.user_id = b.user_id and h.status in ('closed', 'returned')),
                    'user_incidents', (select count(*) from incidents i join bookings h on h.id = i.booking_id where h.user_id = b.user_id))
                  order by b.created_at), '[]'::jsonb)
                 from bookings b
                 where b.status in ('pending_review', 'waitlisted', 'blocked') and b.user_id <> auth.uid()
                   and upper(b.during) > now() and can_manage_resource(b.resource_id)),
    'returns', (select coalesce(jsonb_agg(_booking_summary(b) order by b.returned_at), '[]'::jsonb)
                from bookings b where b.status = 'returned' and b.user_id <> auth.uid() and can_manage_resource(b.resource_id)),
    'active', (select coalesce(jsonb_agg(_booking_summary(b) order by lower(b.during)), '[]'::jsonb)
               from bookings b where b.status in ('approved', 'checked_in', 'overdue') and can_manage_resource(b.resource_id)
                 and lower(b.during) < now() + interval '7 days'));
end $$;

create or replace function incident_feed() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(i) - 'ai_summary' || jsonb_build_object(
            'booking', _booking_summary(b),
            'reported_by_card', _person_card(i.reported_by),
            'resolved_by_card', _person_card(i.resolved_by),
            'ai_summary', case when can_manage_resource(b.resource_id) then i.ai_summary end,
            'can_resolve', i.status <> 'resolved' and b.user_id <> auth.uid()
                           and is_manager_of((select department_id from resources r where r.id = b.resource_id)))
          order by (i.status = 'resolved'), i.created_at desc), '[]'::jsonb)
          from incidents i join bookings b on b.id = i.booking_id
          where b.user_id = auth.uid() or can_manage_resource(b.resource_id));
end $$;

create or replace function audit_feed(p_entity audit_entity default null, p_limit int default 100, p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_me profiles := _me();
begin
  if v_me.id is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', a.id, 'at', a.created_at, 'entity', a.entity, 'entity_id', a.entity_id, 'action', a.action,
            'from', a.from_state, 'to', a.to_state, 'reason', a.reason, 'actor', _person_card(a.actor_id),
            'actor_role', a.actor_role, 'metadata', a.metadata - 'checks') order by a.id desc), '[]'::jsonb)
          from (
            select a.* from audit_log a
            where (p_entity is null or a.entity = p_entity)
              and (p_before is null or a.id < p_before)
              and (
                is_admin()
                or (a.entity = 'booking' and can_view_booking(a.entity_id))
                or (a.entity = 'incident' and exists (select 1 from incidents i where i.id = a.entity_id and can_view_booking(i.booking_id)))
                or (a.entity = 'resource' and can_manage_resource(a.entity_id))
                or (a.entity = 'qualification' and exists (select 1 from user_qualifications q where q.id = a.entity_id
                      and (q.user_id = auth.uid() or _can_verify_qualification(q))))
                or (a.entity = 'profile' and (a.entity_id = auth.uid()
                      or is_manager_of((select department_id from profiles p where p.id = a.entity_id))))
              )
            order by a.id desc
            limit least(greatest(coalesce(p_limit, 100), 1), 500)
          ) a);
end $$;

create or replace function verification_queue() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_me profiles := _me();
begin
  if v_me.id is null or v_me.verification_status <> 'verified' or v_me.role = 'user' then
    return jsonb_build_object('profiles', '[]'::jsonb, 'qualifications', '[]'::jsonb, 'users', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'profiles', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'role', p.role,
                    'department', (select code from departments d where d.id = p.department_id), 'year_of_study', p.year_of_study,
                    'roll_number', p.roll_number, 'created_at', p.created_at) order by p.created_at), '[]'::jsonb)
                 from profiles p where p.verification_status = 'pending' and p.id <> auth.uid()
                   and (is_admin() or (p.role not in ('manager', 'admin') and p.department_id is not null and is_manager_of(p.department_id)))),
    'qualifications', (select coalesce(jsonb_agg(to_jsonb(q) || jsonb_build_object('user', _person_card(q.user_id)) order by q.created_at), '[]'::jsonb)
                       from user_qualifications q where q.status = 'pending' and _can_verify_qualification(q)),
    'users', case when is_admin() or v_me.role = 'manager' then
               (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'role', p.role,
                    'department', (select code from departments d where d.id = p.department_id), 'verification_status', p.verification_status,
                    'strikes', p.strikes, 'suspended_until', p.suspended_until) order by p.full_name), '[]'::jsonb)
                from profiles p where is_admin() or (p.department_id is not null and is_manager_of(p.department_id)))
             else '[]'::jsonb end);
end $$;

-- Usage concentration per resource: the anti-monopolisation view for managers.
create or replace function fairness_report() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(x order by (x->>'total_hours')::numeric desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'resource', jsonb_build_object('id', r.id, 'name', r.name),
      'total_hours', round(coalesce(sum(extract(epoch from upper(b.during) - lower(b.during))) / 3600, 0)::numeric, 1),
      'distinct_users', count(distinct b.user_id),
      'top_share', case when count(b.id) = 0 then 0 else round(100.0 * (
           select max(cnt) from (select count(*) cnt from bookings b2 where b2.resource_id = r.id and _counts_as_usage(b2.status)
                                 and lower(b2.during) > now() - interval '30 days' group by b2.user_id) t) / count(b.id), 0) end,
      'waitlisted', (select count(*) from bookings w where w.resource_id = r.id and w.status = 'waitlisted'),
      'top_users', (select coalesce(jsonb_agg(jsonb_build_object('user', _person_card(t.user_id), 'bookings', t.cnt) order by t.cnt desc), '[]'::jsonb)
                    from (select b3.user_id, count(*) cnt from bookings b3 where b3.resource_id = r.id and _counts_as_usage(b3.status)
                          and lower(b3.during) > now() - interval '30 days' group by b3.user_id order by count(*) desc limit 5) t)
    ) x
    from resources r
    left join bookings b on b.resource_id = r.id and _counts_as_usage(b.status) and lower(b.during) > now() - interval '30 days'
    where can_manage_resource(r.id)
    group by r.id) s);
end $$;

create or replace function list_departments() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name) order by code), '[]'::jsonb) from departments
$$;
