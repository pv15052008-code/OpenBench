-- OpenBench · 0006 saving resources in one atomic call, and realtime notifications
--
-- An owner's listing is a resource row plus its requirements, opening hours and
-- fairness caps. Saving them in four separate client writes can leave half a
-- listing behind if the network drops, so the app calls save_resource() instead,
-- and clients lose direct write access to these tables.

create or replace function save_resource(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me     profiles := _me();
  v_id     uuid := _try_uuid(p->>'id');
  v_old    resources;
  v_dept   uuid := _try_uuid(p->>'department_id');
  v_item   jsonb;
  v_status resource_status := coalesce(nullif(p->>'status', ''), 'draft')::resource_status;
begin
  if v_me.id is null or v_me.verification_status <> 'verified' or v_me.role not in ('owner', 'manager', 'admin') then
    raise exception 'Only verified owners can list resources' using errcode = '42501';
  end if;

  if v_id is not null then
    select * into v_old from resources where id = v_id for update;
    if v_old.id is null or not can_manage_resource(v_id) then
      raise exception 'Resource not found' using errcode = 'P0002';
    end if;
    v_dept := coalesce(v_dept, v_old.department_id);
    if v_dept is distinct from v_old.department_id and not is_admin() then
      raise exception 'Only an admin can move a resource to another department' using errcode = '42501';
    end if;
  else
    if v_me.role <> 'admin' then
      v_dept := v_me.department_id;  -- owners and managers list only in their own department
    end if;
    if v_dept is null then
      raise exception 'Choose a department' using errcode = '22023';
    end if;
  end if;

  if jsonb_typeof(coalesce(p->'checklist_template', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p->'checklist_template', '[]'::jsonb)) > 20 then
    raise exception 'Checklist must be a list of at most 20 items' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p->'checklist_template', '[]'::jsonb)) e
             where length(coalesce(e->>'label', '')) not between 2 and 120 or coalesce(e->>'key', '') !~ '^[a-z0-9_]{1,40}$') then
    raise exception 'Each checklist item needs a short label' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p->'requirements', '[]'::jsonb)) > 10 or jsonb_array_length(coalesce(p->'availability', '[]'::jsonb)) > 40 then
    raise exception 'Too many requirements or opening-hour rows' using errcode = '22023';
  end if;

  if v_id is null then
    insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                           max_minutes_per_booking, lead_time_hours, max_advance_days, deposit_note, usage_rules,
                           checklist_template, photo_urls, status, requires_supervision)
    values (v_me.id, v_dept, (p->>'kind')::resource_kind, btrim(p->>'category'), btrim(p->>'name'),
            coalesce(btrim(p->>'description'), ''), btrim(p->>'location'),
            coalesce((p->>'quantity')::int, 1), coalesce((p->>'slot_minutes')::int, 60),
            coalesce((p->>'max_minutes_per_booking')::int, 240), coalesce((p->>'lead_time_hours')::int, 2),
            coalesce((p->>'max_advance_days')::int, 30), coalesce(btrim(p->>'deposit_note'), ''),
            coalesce(btrim(p->>'usage_rules'), ''), coalesce(p->'checklist_template', '[]'::jsonb),
            coalesce(array(select jsonb_array_elements_text(p->'photo_urls')), '{}'), v_status,
            coalesce((p->>'requires_supervision')::boolean, false))
    returning id into v_id;
  else
    perform _set_context('resource_updated', nullif(btrim(coalesce(p->>'change_reason', '')), ''));
    update resources set
      department_id = coalesce(v_dept, department_id),
      kind = (p->>'kind')::resource_kind, category = btrim(p->>'category'), name = btrim(p->>'name'),
      description = coalesce(btrim(p->>'description'), ''), location = btrim(p->>'location'),
      quantity = coalesce((p->>'quantity')::int, 1), slot_minutes = coalesce((p->>'slot_minutes')::int, 60),
      max_minutes_per_booking = coalesce((p->>'max_minutes_per_booking')::int, 240),
      lead_time_hours = coalesce((p->>'lead_time_hours')::int, 2), max_advance_days = coalesce((p->>'max_advance_days')::int, 30),
      deposit_note = coalesce(btrim(p->>'deposit_note'), ''), usage_rules = coalesce(btrim(p->>'usage_rules'), ''),
      checklist_template = coalesce(p->'checklist_template', '[]'::jsonb),
      photo_urls = coalesce(array(select jsonb_array_elements_text(p->'photo_urls')), photo_urls),
      status = v_status, requires_supervision = coalesce((p->>'requires_supervision')::boolean, false)
    where id = v_id;
  end if;

  -- New photo URLs must be this deployment's own public resource-photos bucket (app_settings.storage_base,
  -- e.g. https://xyz.supabase.co, so another Supabase project can't be used to track viewers), in the folder of the
  -- owner or of the person saving (a manager adding a photo uploads to their own folder).
  -- Photos already on the listing were checked when they were added.
  if exists (
    select 1 from resources r, unnest(r.photo_urls) u
    where r.id = v_id
      and not (u = any (coalesce(v_old.photo_urls, '{}')))
      and not (
        (_settings()).storage_base <> ''
        and left(u, length((_settings()).storage_base)) = (_settings()).storage_base
        and substr(u, length((_settings()).storage_base) + 1) ~ ('^/storage/v1/object/public/resource-photos/(' || r.owner_id::text || '|' || auth.uid()::text || ')/[A-Za-z0-9._-]{1,120}$')
      )) then
    raise exception 'Photos must be uploaded through OpenBench%',
      case when (_settings()).storage_base = '' then ' (an admin must set app_settings.storage_base to this project''s URL)' else '' end
      using errcode = '22023';
  end if;
  if (select cardinality(photo_urls) from resources where id = v_id) > 6 then
    raise exception 'At most 6 photos per listing' using errcode = '22023';
  end if;

  if p ? 'requirements' then
    delete from resource_requirements where resource_id = v_id;
    for v_item in select * from jsonb_array_elements(p->'requirements') loop
      if v_item->>'type' = 'training' and coalesce(v_item->>'value', '') !~ '^[a-z0-9_-]{2,40}$' then
        raise exception 'Training tags use lowercase letters, digits and underscores' using errcode = '22023';
      end if;
      if v_item->>'type' = 'min_year' and coalesce(v_item->>'value', '') !~ '^[1-6]$' then
        raise exception 'Minimum year must be 1 to 6' using errcode = '22023';
      end if;
      if v_item->>'type' = 'training' and not exists (select 1 from training_tags where tag = btrim(v_item->>'value')) then
        -- A new training belongs to this resource's department, and only a manager of that department
        -- (or an admin) can register it, so nobody can claim another department's induction first
        if not is_manager_of((select department_id from resources where id = v_id)) then
          raise exception 'The training "%" is not registered. Ask your department manager to add it first.', btrim(v_item->>'value')
            using errcode = '42501';
        end if;
        insert into training_tags (tag, label, department_id)
        values (btrim(v_item->>'value'), btrim(v_item->>'label'), (select department_id from resources where id = v_id));
      end if;
      insert into resource_requirements (resource_id, type, value, label)
      values (v_id, (v_item->>'type')::requirement_type, btrim(v_item->>'value'), btrim(v_item->>'label'));
    end loop;
  end if;

  if p ? 'availability' then
    delete from availability_rules where resource_id = v_id;
    for v_item in select * from jsonb_array_elements(p->'availability') loop
      insert into availability_rules (resource_id, weekday, opens_at, closes_at, blackout_date, note)
      values (v_id, (v_item->>'weekday')::smallint, (v_item->>'opens_at')::time, (v_item->>'closes_at')::time,
              (v_item->>'blackout_date')::date, coalesce(v_item->>'note', ''));
    end loop;
  end if;

  if p ? 'policy' and jsonb_typeof(p->'policy') = 'object' then
    insert into fairness_policies (resource_id, max_bookings_per_week, max_minutes_per_week, cooldown_hours, first_timer_priority, max_open_strikes)
    values (v_id, coalesce((p->'policy'->>'max_bookings_per_week')::int, 3), coalesce((p->'policy'->>'max_minutes_per_week')::int, 480),
            coalesce((p->'policy'->>'cooldown_hours')::int, 0), coalesce((p->'policy'->>'first_timer_priority')::boolean, true),
            coalesce((p->'policy'->>'max_open_strikes')::smallint, 3))
    on conflict (resource_id) do update set
      max_bookings_per_week = excluded.max_bookings_per_week, max_minutes_per_week = excluded.max_minutes_per_week,
      cooldown_hours = excluded.cooldown_hours, first_timer_priority = excluded.first_timer_priority,
      max_open_strikes = excluded.max_open_strikes;
  elsif p ? 'policy' and p->'policy' = 'null'::jsonb then
    delete from fairness_policies where resource_id = v_id;
  end if;

  return v_id;
end $$;

-- Lists the training tags in use, so the profile screen can offer them
create or replace function list_training_tags() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('tag', t.tag, 'label', t.label, 'department', d.code) order by t.label), '[]'::jsonb)
  from training_tags t join departments d on d.id = t.department_id
$$;

create or replace function list_courses() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name, 'department', d.code) order by c.code), '[]'::jsonb)
  from courses c join departments d on d.id = c.department_id where c.active
$$;

-- Clients no longer write these tables directly
revoke insert, update, delete on resources, resource_requirements, availability_rules, fairness_policies from authenticated;

revoke execute on function save_resource(jsonb), list_training_tags(), list_courses() from public, anon;
grant execute on function save_resource(jsonb), list_training_tags(), list_courses() to authenticated;

-- Realtime: push new notifications (filtered by RLS) to the signed-in user
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table notifications;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
