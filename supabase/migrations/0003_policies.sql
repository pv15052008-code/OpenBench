-- OpenBench · 0003 row-level security and grants
-- Default deny: RLS is enabled on every table, anon gets nothing, and the
-- authenticated role only gets the rights listed here. All lifecycle writes go
-- through the RPCs in 0002.

alter table app_settings          enable row level security;
alter table departments           enable row level security;
alter table courses               enable row level security;
alter table training_tags         enable row level security;
alter table profiles              enable row level security;
alter table resources             enable row level security;
alter table resource_requirements enable row level security;
alter table availability_rules    enable row level security;
alter table user_qualifications   enable row level security;
alter table fairness_policies     enable row level security;
alter table bookings              enable row level security;
alter table condition_records     enable row level security;
alter table incidents             enable row level security;
alter table notifications         enable row level security;
alter table audit_log             enable row level security;

-- ---------------------------------------------------------------------------
-- Table privileges: start from nothing, then grant the minimum
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on departments, courses, training_tags to authenticated;
-- Settings: everything except internal switches
grant select (id, institution_name, timezone, early_checkin_minutes, no_show_grace_minutes, suspension_days, dispute_window_days)
  on app_settings to authenticated;
grant select, update on profiles to authenticated;                         -- update limited by trigger + policy
grant select, insert, update on resources to authenticated;                -- no delete: retire instead
grant select, insert, update, delete on resource_requirements to authenticated;
grant select, insert, update, delete on availability_rules to authenticated;
grant select, insert, update, delete on fairness_policies to authenticated;
grant select, insert, update on user_qualifications to authenticated;     -- status forced to pending by trigger
grant select on condition_records to authenticated;                       -- writes only through RPCs
-- Bookings and incidents: every column except the staff-only advisory fields
-- (AI briefs and summaries, the fair-allocation working with other students' facts).
-- Staff read those through get_booking() and review_queue(), which check the caller.
grant select (id, resource_id, user_id, during, quantity, pooled, purpose, course_code, deposit_acknowledged, status,
              decision_reason, decided_by, decided_at, checked_in_at, returned_at, closed_at, created_at, updated_at)
  on bookings to authenticated;
grant select (id, booking_id, reported_by, type, severity, description, photo_paths, estimated_cost, status, resolution,
              strike_applied, resolved_by, resolved_at, created_at, updated_at)
  on incidents to authenticated;
grant select on notifications to authenticated;                            -- read state changed via RPC
-- audit_log: no direct grant at all; read through audit_feed() and get_booking()

-- Column-level: a user may only update these profile columns directly
revoke update on profiles from authenticated;
grant update (full_name, department_id, year_of_study, roll_number, avatar_url) on profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
create policy settings_read on app_settings for select to authenticated using (true);
create policy departments_read on departments for select to authenticated using (true);
create policy courses_read on courses for select to authenticated using (true);
create policy training_tags_read on training_tags for select to authenticated using (true);

-- Profiles: yourself, plus staff who verify people in their scope.
-- Other people's names reach the UI through _person_card() inside RPCs.
create policy profiles_self_read on profiles for select to authenticated
  using (id = auth.uid() or is_admin() or (department_id is not null and is_manager_of(department_id)));
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Resources: active ones are visible to every signed-in user; drafts only to managers of it
create policy resources_read on resources for select to authenticated
  using (status = 'active' or can_manage_resource(id));
create policy resources_insert on resources for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (select 1 from profiles p where p.id = auth.uid() and p.verification_status = 'verified'
                and p.role in ('owner', 'manager', 'admin')
                and (p.role = 'admin' or p.department_id = resources.department_id)));
create policy resources_update on resources for update to authenticated
  using (can_manage_resource(id)) with check (can_manage_resource(id));

-- Child tables of a resource follow the resource
create policy requirements_read on resource_requirements for select to authenticated
  using (exists (select 1 from resources r where r.id = resource_id and (r.status = 'active' or can_manage_resource(r.id))));
create policy requirements_write on resource_requirements for all to authenticated
  using (can_manage_resource(resource_id)) with check (can_manage_resource(resource_id));

create policy availability_read on availability_rules for select to authenticated
  using (exists (select 1 from resources r where r.id = resource_id and (r.status = 'active' or can_manage_resource(r.id))));
create policy availability_write on availability_rules for all to authenticated
  using (can_manage_resource(resource_id)) with check (can_manage_resource(resource_id));

create policy fairness_read on fairness_policies for select to authenticated using (true);
create policy fairness_write_resource on fairness_policies for all to authenticated
  using ((resource_id is not null and can_manage_resource(resource_id)) or (department_id is not null and is_manager_of(department_id)))
  with check ((resource_id is not null and can_manage_resource(resource_id)) or (department_id is not null and is_manager_of(department_id)));

-- Qualifications: your own, or ones you are allowed to verify
create policy qualifications_read on user_qualifications for select to authenticated
  using (user_id = auth.uid() or _can_verify_qualification(user_qualifications));
create policy qualifications_insert on user_qualifications for insert to authenticated
  with check (user_id = auth.uid());
create policy qualifications_update on user_qualifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Bookings and their evidence: the two parties (and managers above them)
create policy bookings_read on bookings for select to authenticated
  using (user_id = auth.uid() or can_manage_resource(resource_id));
create policy records_read on condition_records for select to authenticated
  using (can_view_booking(booking_id));
create policy incidents_read on incidents for select to authenticated
  using (can_view_booking(booking_id));

create policy notifications_read on notifications for select to authenticated
  using (user_id = auth.uid());

-- audit_log has RLS on and no policy for authenticated: direct reads return nothing.

-- ---------------------------------------------------------------------------
-- Function privileges: nothing by default, then the public RPC surface
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- Helpers that policies call must be executable by the role the policy runs as
grant execute on function
  is_admin(), is_manager_of(uuid), can_manage_resource(uuid), can_view_booking(uuid),
  _can_verify_qualification(user_qualifications), _privileged(), _seeding()
to authenticated;

grant execute on function
  preview_booking(uuid, timestamptz, timestamptz, int, text),
  request_booking(uuid, timestamptz, timestamptz, int, text, text, boolean),
  decide_booking(uuid, text, text, boolean),
  cancel_booking(uuid, text),
  check_in(uuid, jsonb, text[], text),
  return_booking(uuid, jsonb, text[], text),
  confirm_return(uuid, text),
  report_incident(uuid, incident_type, incident_severity, text, text[], numeric),
  review_incident(uuid),
  resolve_incident(uuid, text, boolean),
  sweep_due(),
  verify_profile(uuid, verification_status, text),
  set_user_role(uuid, user_role, uuid, text),
  clear_strikes(uuid, text),
  verify_qualification(uuid, qualification_status, text, date),
  mark_notifications_read(uuid[]),
  list_resources(text, text, uuid, resource_kind, boolean, boolean),
  get_resource(uuid),
  my_bookings(),
  get_booking(uuid),
  review_queue(),
  incident_feed(),
  audit_feed(audit_entity, int, bigint),
  verification_queue(),
  fairness_report(),
  list_departments()
to authenticated;

-- Trigger functions are invoked by the database, never called directly
revoke execute on function handle_new_user() from public, anon, authenticated;
