-- OpenBench · 0001 schema
-- Tables, enums, constraints. Logic lives in 0002, row-level security in 0003, storage in 0004.

create extension if not exists "pgcrypto";
create extension if not exists "btree_gist";   -- lets the exclusion constraint compare uuid = and range &&

-- ---------------------------------------------------------------------------
-- Enums: one closed set per concept so the app and the database agree
-- ---------------------------------------------------------------------------
create type user_role as enum ('user', 'owner', 'manager', 'admin');
create type verification_status as enum ('pending', 'verified', 'rejected');
create type resource_kind as enum ('equipment', 'space');
create type resource_status as enum ('draft', 'active', 'maintenance', 'retired');
create type requirement_type as enum ('training', 'min_year', 'department', 'faculty_sponsor');
create type qualification_status as enum ('pending', 'verified', 'rejected', 'expired');
create type booking_status as enum (
  'requested', 'blocked', 'pending_review', 'approved', 'rejected', 'waitlisted',
  'cancelled', 'checked_in', 'returned', 'closed', 'disputed', 'no_show', 'overdue'
);
create type condition_phase as enum ('checkin', 'return');
create type incident_type as enum ('damage', 'delay', 'missing', 'misuse', 'conflict', 'other');
create type incident_severity as enum ('low', 'medium', 'high');
create type incident_status as enum ('open', 'under_review', 'resolved');
create type audit_entity as enum ('booking', 'resource', 'qualification', 'incident', 'profile');

-- ---------------------------------------------------------------------------
-- Institution settings: exactly one row
-- ---------------------------------------------------------------------------
create table app_settings (
  id                      boolean primary key default true check (id),
  institution_name        text not null default 'Demo Institute of Technology',
  timezone                text not null default 'Asia/Kolkata',
  allowed_email_domains   text[] not null default '{}',     -- empty = any domain may sign up (still unverified)
  early_checkin_minutes   integer not null default 30 check (early_checkin_minutes between 0 and 1440),
  no_show_grace_minutes   integer not null default 30 check (no_show_grace_minutes between 5 and 1440),
  suspension_days         integer not null default 14 check (suspension_days between 1 and 365),
  dispute_window_days     integer not null default 7 check (dispute_window_days between 0 and 60),
  -- Demo resets wipe data; they only run when this is switched on (scripts/seed-demo.mjs does it)
  demo_mode               boolean not null default false,
  -- Public storage base for listing photos when not on *.supabase.co (custom domain, local testing)
  storage_base            text not null default '' check (storage_base = '' or storage_base ~ '^https?://[A-Za-z0-9.:-]+$')
);
insert into app_settings default values;

-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------
create table departments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{2,8}$'),
  name        text not null check (length(name) between 2 and 80),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Profiles: one row per auth user. role / verification / strikes are
-- protected by a trigger so a user can never edit them (see 0003).
-- ---------------------------------------------------------------------------
create table profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text not null unique,
  full_name           text not null check (length(full_name) between 2 and 80),
  role                user_role not null default 'user',
  department_id       uuid references departments(id),
  year_of_study       smallint check (year_of_study between 1 and 6),
  roll_number         text check (roll_number ~ '^[A-Za-z0-9/-]{3,20}$'),
  verification_status verification_status not null default 'pending',
  verified_by         uuid references profiles(id),
  verified_at         timestamptz,
  strikes             smallint not null default 0 check (strikes >= 0),
  suspended_until     timestamptz,
  avatar_url          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index profiles_department_idx on profiles(department_id);
create index profiles_role_idx on profiles(role);

-- ---------------------------------------------------------------------------
-- Resources: anything bookable. quantity = 1 means exclusive (one booking
-- at a time); quantity > 1 means pooled (N kits, capacity checked per slot).
-- ---------------------------------------------------------------------------
create table resources (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references profiles(id),
  department_id         uuid not null references departments(id),
  kind                  resource_kind not null,
  category              text not null check (length(category) between 2 and 40),
  name                  text not null check (length(name) between 3 and 120),
  description           text not null default '' check (length(description) <= 4000),
  location              text not null check (length(location) between 2 and 160),
  quantity              integer not null default 1 check (quantity between 1 and 500),
  slot_minutes          integer not null default 60 check (slot_minutes in (15, 30, 60, 120, 180, 240, 480)),
  max_minutes_per_booking integer not null default 240 check (max_minutes_per_booking between 15 and 10080),
  lead_time_hours       integer not null default 2 check (lead_time_hours between 0 and 720),
  max_advance_days      integer not null default 30 check (max_advance_days between 1 and 365),
  deposit_note          text not null default '' check (length(deposit_note) <= 400),
  usage_rules           text not null default '' check (length(usage_rules) <= 4000),
  checklist_template    jsonb not null default '[]'::jsonb,   -- [{"key":"lens","label":"Lens clean, no scratches"}]
  photo_urls            text[] not null default '{}',
  status                resource_status not null default 'draft',
  requires_supervision  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint resources_checklist_is_array check (jsonb_typeof(checklist_template) = 'array')
);
create index resources_owner_idx on resources(owner_id);
create index resources_dept_idx on resources(department_id);
create index resources_status_idx on resources(status);
create index resources_search_idx on resources using gin (to_tsvector('english', name || ' ' || category || ' ' || description));

-- Eligibility rules on a resource. A user must satisfy every row.
create table resource_requirements (
  id           uuid primary key default gen_random_uuid(),
  resource_id  uuid not null references resources(id) on delete cascade,
  type         requirement_type not null,
  value        text not null check (length(value) between 1 and 80),
  label        text not null check (length(label) between 2 and 160),   -- human text shown in the eligibility panel
  created_at   timestamptz not null default now(),
  unique (resource_id, type, value)
);

-- Weekly opening hours and blackout dates
create table availability_rules (
  id            uuid primary key default gen_random_uuid(),
  resource_id   uuid not null references resources(id) on delete cascade,
  weekday       smallint check (weekday between 0 and 6),          -- 0 = Sunday, null when blackout_date is set
  opens_at      time,
  closes_at     time,
  blackout_date date,
  note          text not null default '' check (length(note) <= 160),
  constraint availability_shape check (
    (weekday is not null and opens_at is not null and closes_at is not null and opens_at < closes_at and blackout_date is null)
    or (weekday is null and opens_at is null and closes_at is null and blackout_date is not null)
  )
);
create index availability_resource_idx on availability_rules(resource_id);

-- Courses run by faculty. A request linked to a course must name one of these.
create table courses (
  code          text primary key check (code ~ '^[A-Z]{2,4}-[0-9]{3}$'),
  name          text not null check (length(name) between 2 and 120),
  department_id uuid not null references departments(id),
  faculty_id    uuid references profiles(id),
  active        boolean not null default true
);

-- Training tags belong to the department that runs the induction. Only that
-- department's staff can verify certificates for it.
create table training_tags (
  tag           text primary key check (tag ~ '^[a-z0-9_-]{2,40}$'),
  label         text not null check (length(label) between 2 and 160),
  department_id uuid not null references departments(id),
  created_at    timestamptz not null default now()
);

-- What a user has proven (training certificates etc.)
create table user_qualifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  training_tag  text not null check (training_tag ~ '^[a-z0-9_-]{2,40}$'),
  evidence_path text,                                   -- storage object path in bucket eligibility-docs
  status        qualification_status not null default 'pending',
  verified_by   uuid references profiles(id),
  verified_at   timestamptz,
  decision_reason text check (length(decision_reason) <= 400),
  expires_at    date,
  ai_review     jsonb,                                  -- advisory only, written by the API service
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, training_tag)
);
create index qualifications_user_idx on user_qualifications(user_id);
create index qualifications_status_idx on user_qualifications(status);

-- Fairness caps. scope: a single resource, or a whole department (resource_id null)
create table fairness_policies (
  id                     uuid primary key default gen_random_uuid(),
  resource_id            uuid references resources(id) on delete cascade,
  department_id          uuid references departments(id) on delete cascade,
  max_bookings_per_week  integer not null default 3 check (max_bookings_per_week between 1 and 50),
  max_minutes_per_week   integer not null default 480 check (max_minutes_per_week between 15 and 10080),
  cooldown_hours         integer not null default 0 check (cooldown_hours between 0 and 168),
  first_timer_priority   boolean not null default true,
  max_open_strikes       smallint not null default 3 check (max_open_strikes between 1 and 10),
  created_at             timestamptz not null default now(),
  constraint fairness_scope check ((resource_id is null) <> (department_id is null)),
  unique (resource_id),
  unique (department_id)
);

-- ---------------------------------------------------------------------------
-- Bookings: one row per request for its whole life.
-- `during` is a tstzrange so Postgres itself refuses overlapping approvals.
-- ---------------------------------------------------------------------------
create table bookings (
  id                     uuid primary key default gen_random_uuid(),
  resource_id            uuid not null references resources(id),
  user_id                uuid not null references profiles(id),
  during                 tstzrange not null,
  quantity               integer not null default 1 check (quantity >= 1),
  pooled                 boolean not null default false,           -- copied from resource.quantity > 1 at request time
  purpose                text not null check (length(purpose) between 10 and 600),
  course_code            text check (course_code ~ '^[A-Z]{2,4}-?[0-9]{3}$'),
  deposit_acknowledged   boolean not null default false,
  status                 booking_status not null default 'requested',
  decision_reason        text check (length(decision_reason) <= 600),
  decided_by             uuid references profiles(id),
  decided_at             timestamptz,
  allocation_explanation jsonb not null default '{}'::jsonb,
  ai_brief               jsonb,                                     -- advisory summary for the owner
  checked_in_at          timestamptz,
  returned_at            timestamptz,
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint booking_range_valid check (lower(during) < upper(during) and not lower_inf(during) and not upper_inf(during)),
  -- The line that makes double booking impossible for exclusive resources:
  constraint bookings_no_overlap exclude using gist (resource_id with =, during with &&)
    where (status in ('approved', 'checked_in', 'overdue') and not pooled)
);
create index bookings_resource_during_idx on bookings using gist (resource_id, during);
create index bookings_user_idx on bookings(user_id, created_at desc);
create index bookings_status_idx on bookings(status);
create index bookings_open_idx on bookings(resource_id) where status in ('pending_review', 'waitlisted', 'blocked');

-- Check-in and return evidence. Immutable once written (no update policy, no update trigger).
create table condition_records (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references bookings(id) on delete cascade,
  phase         condition_phase not null,
  checklist     jsonb not null default '[]'::jsonb,      -- [{"key":"lens","label":"...","ok":true,"note":""}]
  photo_paths   text[] not null default '{}',
  notes         text not null default '' check (length(notes) <= 2000),
  recorded_by   uuid not null references profiles(id),
  recorded_at   timestamptz not null default now(),
  countersigned_by uuid references profiles(id),
  countersigned_at timestamptz,
  unique (booking_id, phase),
  constraint condition_checklist_is_array check (jsonb_typeof(checklist) = 'array'),
  constraint condition_has_photo check (cardinality(photo_paths) >= 1)
);

create table incidents (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references bookings(id) on delete cascade,
  reported_by     uuid not null references profiles(id),
  type            incident_type not null,
  severity        incident_severity not null default 'medium',
  description     text not null check (length(description) between 10 and 3000),
  photo_paths     text[] not null default '{}',
  estimated_cost  numeric(10,2) check (estimated_cost >= 0),
  status          incident_status not null default 'open',
  resolution      text check (length(resolution) <= 2000),
  strike_applied  boolean not null default false,
  resolved_by     uuid references profiles(id),
  resolved_at     timestamptz,
  ai_summary      jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index incidents_booking_idx on incidents(booking_id);
create index incidents_status_idx on incidents(status);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  type        text not null check (type ~ '^[a-z_]{3,40}$'),
  title       text not null check (length(title) between 2 and 120),
  body        text not null default '' check (length(body) <= 600),
  booking_id  uuid references bookings(id) on delete cascade,
  read_at     timestamptz,
  emailed_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on notifications(user_id, created_at desc);
create index notifications_unread_idx on notifications(user_id) where read_at is null;

-- Append-only. Written by triggers only. Nobody updates or deletes rows here.
create table audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references profiles(id),
  actor_role  user_role,
  entity      audit_entity not null,
  entity_id   uuid not null,
  action      text not null check (length(action) between 2 and 60),
  from_state  text,
  to_state    text,
  reason      text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_entity_idx on audit_log(entity, entity_id, created_at);
create index audit_actor_idx on audit_log(actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_updated_at before update on profiles for each row execute function set_updated_at();
create trigger resources_updated_at before update on resources for each row execute function set_updated_at();
create trigger qualifications_updated_at before update on user_qualifications for each row execute function set_updated_at();
create trigger bookings_updated_at before update on bookings for each row execute function set_updated_at();
create trigger incidents_updated_at before update on incidents for each row execute function set_updated_at();
