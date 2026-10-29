-- OpenBench · 0005 demo data
-- seed_demo() rebuilds a fictional campus. All names, rooms and people are invented.
-- It expects the demo accounts to exist in auth.users already (scripts/seed-demo.mjs
-- creates them through the Supabase admin API, with passwords). Only the service
-- role can run it; the admin's "Reset demo data" button reaches it through the API.

create or replace function seed_demo() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz      text := 'Asia/Kolkata';
  d_me uuid; d_ece uuid; d_cse uuid;
  u_admin uuid; u_hod uuid; u_mehta uuid; u_rao uuid; u_kapoor uuid;
  u_aarav uuid; u_isha uuid; u_kabir uuid; u_new uuid;
  r_printer uuid; r_laser uuid; r_lab uuid; r_scope uuid; r_kits uuid; r_fgen uuid; r_hall uuid; r_camera uuid; r_drone uuid;
  b_id uuid;
  v_today   timestamptz := date_trunc('day', now() at time zone v_tz) at time zone v_tz;   -- today 00:00 IST
  v_slot    timestamptz := date_trunc('hour', now()) + case when extract(minute from now()) >= 30 then interval '30 minutes' else interval '0' end;
  v_checklist_printer jsonb := '[{"key":"bed","label":"Print bed clean and level"},{"key":"nozzle","label":"Nozzle free of residue"},{"key":"spool","label":"Filament spool mounted, no tangles"},{"key":"panel","label":"Display and controls respond"}]';
  v_checklist_scope   jsonb := '[{"key":"probes","label":"All 4 probes present and undamaged"},{"key":"screen","label":"Screen free of cracks"},{"key":"power","label":"Powers on, self-test passes"}]';
  v_checklist_camera  jsonb := '[{"key":"body","label":"Body free of scratches"},{"key":"lens","label":"Lens glass clean, caps on"},{"key":"battery","label":"2 batteries and charger"},{"key":"card","label":"SD card formatted"}]';
  v_checklist_kit     jsonb := '[{"key":"board","label":"Board powers on"},{"key":"parts","label":"Component bag sealed and complete"}]';
  v_checklist_room    jsonb := '[{"key":"clean","label":"Room clean, benches cleared"},{"key":"power","label":"Projector and AC switched off"}]';
begin
  if not (select demo_mode from app_settings where id) then
    raise exception 'Demo mode is off. seed_demo() wipes data, so it only runs on a demo deployment (set app_settings.demo_mode).';
  end if;
  -- Seeding mode: lifecycle triggers skip their audit/notification work for this transaction,
  -- because the seed writes its own history rows. Clients cannot set this flag (no RPC exposes set_config).
  perform set_config('openbench.seeding', 'on', true);
  -- Wipe everything except profiles and settings.
  -- "where true" on purpose: Supabase's safeupdate guard refuses a DELETE or UPDATE without a WHERE clause
  delete from notifications where true; delete from audit_log where true; delete from incidents where true;
  delete from condition_records where true; delete from bookings where true; delete from user_qualifications where true;
  delete from fairness_policies where true; delete from availability_rules where true;
  delete from resource_requirements where true; delete from resources where true;
  delete from training_tags where true; delete from courses where true;
  update profiles set department_id = null where department_id is not null;
  delete from departments where true;

  insert into departments (code, name) values ('ME', 'Mechanical Engineering') returning id into d_me;
  insert into departments (code, name) values ('ECE', 'Electronics & Communication') returning id into d_ece;
  insert into departments (code, name) values ('CSE', 'Computer Science & Engineering') returning id into d_cse;

  select id into u_admin  from profiles where email = 'admin@demo.openbench.in';
  select id into u_hod    from profiles where email = 'hod.sharma@demo.openbench.in';
  select id into u_mehta  from profiles where email = 'prof.mehta@demo.openbench.in';
  select id into u_rao    from profiles where email = 'dr.rao@demo.openbench.in';
  select id into u_kapoor from profiles where email = 'ms.kapoor@demo.openbench.in';
  select id into u_aarav  from profiles where email = 'aarav@demo.openbench.in';
  select id into u_isha   from profiles where email = 'isha@demo.openbench.in';
  select id into u_kabir  from profiles where email = 'kabir@demo.openbench.in';
  select id into u_new    from profiles where email = 'newstudent@demo.openbench.in';
  if u_admin is null or u_hod is null or u_mehta is null or u_rao is null or u_kapoor is null
     or u_aarav is null or u_isha is null or u_kabir is null or u_new is null then
    raise exception 'Demo accounts missing: run scripts/seed-demo.mjs first';
  end if;

  update profiles set full_name = 'Dr. Neha Iyer',     role = 'admin',   department_id = null,  year_of_study = null, roll_number = null,       verification_status = 'verified', verified_at = now(), strikes = 0, suspended_until = null where id = u_admin;
  update profiles set full_name = 'Prof. R. Sharma',   role = 'manager', department_id = d_me,  year_of_study = null, roll_number = 'FAC-ME-01', verification_status = 'verified', verified_at = now(), strikes = 0, suspended_until = null where id = u_hod;
  update profiles set full_name = 'Prof. Vikram Mehta',role = 'owner',   department_id = d_me,  year_of_study = null, roll_number = 'FAC-ME-07', verification_status = 'verified', verified_at = now(), strikes = 0, suspended_until = null where id = u_mehta;
  update profiles set full_name = 'Dr. Anjali Rao',    role = 'owner',   department_id = d_ece, year_of_study = null, roll_number = 'FAC-EC-03', verification_status = 'verified', verified_at = now(), strikes = 0, suspended_until = null where id = u_rao;
  update profiles set full_name = 'Ms. Tara Kapoor',   role = 'owner',   department_id = d_cse, year_of_study = null, roll_number = 'STF-CS-02', verification_status = 'verified', verified_at = now(), strikes = 0, suspended_until = null where id = u_kapoor;
  update profiles set full_name = 'Aarav Singh',       role = 'user',    department_id = d_ece, year_of_study = 3,    roll_number = '23ECE041',  verification_status = 'verified', verified_at = now(), strikes = 0, suspended_until = null where id = u_aarav;
  update profiles set full_name = 'Isha Verma',        role = 'user',    department_id = d_me,  year_of_study = 2,    roll_number = '24ME112',   verification_status = 'verified', verified_at = now(), strikes = 1, suspended_until = null where id = u_isha;
  update profiles set full_name = 'Kabir Nair',        role = 'user',    department_id = d_cse, year_of_study = 2,    roll_number = '24CSE077',  verification_status = 'verified', verified_at = now(), strikes = 0, suspended_until = null where id = u_kabir;
  update profiles set full_name = 'Riya Das',          role = 'user',    department_id = d_cse, year_of_study = 1,    roll_number = '25CSE019',  verification_status = 'pending',  verified_at = null,  strikes = 0, suspended_until = null where id = u_new;
  update profiles set verified_by = u_admin where id in (u_hod, u_mehta, u_rao, u_kapoor, u_aarav, u_isha, u_kabir);

  -- Resources -------------------------------------------------------------
  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, deposit_note, usage_rules, checklist_template, status)
  values (u_mehta, d_me, 'equipment', '3D printer', 'Prusa MK4 3D Printer',
          'FDM printer, 25 x 21 x 22 cm build volume. PLA and PETG only. Bring your own sliced G-code on USB. The fab lab is open 24x7 with ID-card access.',
          'Fabrication Lab, ME Block B-204', 1, 30, 240, 0, 21,
          'Filament is charged at ₹2 per gram, settled with the lab assistant at return.',
          'Do not leave a print running unattended for more than 20 minutes. Remove supports and clean the bed before returning. ABS is not allowed in this room.',
          v_checklist_printer, 'active') returning id into r_printer;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, deposit_note, usage_rules, checklist_template, status, requires_supervision)
  values (u_mehta, d_me, 'equipment', 'Laser cutter', 'CO2 Laser Cutter 60 W',
          '60 x 40 cm bed. Cuts acrylic and plywood up to 6 mm, engraves leather and glass.',
          'Fabrication Lab, ME Block B-204', 1, 60, 120, 24, 21, '',
          'Supervised use only, a lab assistant must be present. No PVC or vinyl: they release chlorine gas.',
          '[{"key":"lens","label":"Lens clean"},{"key":"extract","label":"Fume extractor running"},{"key":"bed","label":"Honeycomb bed clear of offcuts"}]',
          'active', true) returning id into r_laser;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, usage_rules, checklist_template, status)
  values (u_mehta, d_me, 'space', 'Lab space', 'Workshop Bay B-210 (after hours)',
          'Bench space with hand tools, soldering stations and a bench drill, open to project teams after classes.',
          'ME Block B-210', 1, 60, 180, 4, 14,
          'Book for your whole team in one request. Power tools stay locked; ask the lab assistant.', v_checklist_room, 'active')
  returning id into r_lab;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, usage_rules, checklist_template, status)
  values (u_rao, d_ece, 'equipment', 'Oscilloscope', 'Keysight DSOX1204G Oscilloscope',
          '4 channels, 70 MHz (upgradable to 200 MHz), built-in waveform generator. Comes with 4 passive probes.',
          'Electronics Lab 2, ECE Block A-115', 1, 30, 180, 0, 14,
          'Stays in the lab. Never exceed 300 V CAT II on the inputs.', v_checklist_scope, 'active') returning id into r_scope;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, deposit_note, usage_rules, checklist_template, status)
  values (u_rao, d_ece, 'equipment', 'Microcontroller kit', 'Arduino Uno Starter Kit',
          'Arduino Uno R3, breadboard, jumper wires, sensors (DHT11, HC-SR04, LDR), servo and LCD. 10 kits in the pool.',
          'ECE Store Room, A-102', 10, 240, 10080, 2, 30,
          'Refundable deposit of ₹500 per kit, collected at the store room.',
          'Kits leave the lab. Return every component in the labelled bag.', v_checklist_kit, 'active') returning id into r_kits;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, usage_rules, checklist_template, status)
  values (u_rao, d_ece, 'equipment', 'Signal generator', 'Rigol DG1022Z Function Generator',
          'Dual channel, 25 MHz arbitrary waveform generator.', 'Electronics Lab 2, ECE Block A-115', 1, 30, 180, 0, 14,
          'Stays in the lab.', '[{"key":"cables","label":"BNC cables present"},{"key":"power","label":"Powers on"}]', 'maintenance')
  returning id into r_fgen;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, usage_rules, checklist_template, status)
  values (u_kapoor, d_cse, 'space', 'Seminar hall', 'Seminar Hall S-101',
          '80 seats, projector, two wireless mics, whiteboard.', 'CSE Block, ground floor', 1, 60, 240, 48, 30,
          'Student events need a faculty coordinator. Leave the hall as you found it.', v_checklist_room, 'active')
  returning id into r_hall;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, deposit_note, usage_rules, checklist_template, status)
  values (u_kapoor, d_cse, 'equipment', 'Camera', 'Sony A7 III Camera Kit',
          'Full-frame mirrorless body, 28-70 mm lens, 2 batteries, 64 GB card, tripod.', 'Media Cell, CSE Block C-012', 1, 60, 1440, 12, 21,
          'Any damage is assessed by the media cell; repair cost may be charged.',
          'Return with batteries charged and the card formatted. Do not take it out of campus without written permission.',
          v_checklist_camera, 'active') returning id into r_camera;

  insert into resources (owner_id, department_id, kind, category, name, description, location, quantity, slot_minutes,
                         max_minutes_per_booking, lead_time_hours, max_advance_days, usage_rules, checklist_template, status)
  values (u_kapoor, d_cse, 'equipment', 'Drone', 'DJI Mini 4 Pro Drone',
          'Under 250 g, 4K camera, 3 batteries.', 'Media Cell, CSE Block C-012', 1, 60, 240, 24, 14,
          'Fly only inside the campus sports ground. Drone rules training is required by the institution.',
          '[{"key":"props","label":"Propellers intact"},{"key":"gimbal","label":"Gimbal cover on"},{"key":"batteries","label":"3 batteries"}]', 'active')
  returning id into r_drone;

  insert into training_tags (tag, label, department_id) values
    ('3d_printing', '3D printing safety induction', d_me),
    ('laser_safety', 'Laser cutter safety training', d_me),
    ('electronics_lab', 'Electronics lab safety induction', d_ece),
    ('drone_rules', 'Drone flying rules briefing', d_cse);
  insert into courses (code, name, department_id, faculty_id) values
    ('ECE-304', 'Power Electronics Lab', d_ece, u_rao),
    ('ECE-210', 'Analog Circuits', d_ece, u_rao),
    ('CSE-210', 'Embedded Systems Mini Project', d_cse, u_kapoor),
    ('CSE-301', 'Computer Networks', d_cse, u_kapoor),
    ('ME-201', 'Engineering Design and Prototyping', d_me, u_mehta),
    ('ME-305', 'Manufacturing Processes', d_me, u_hod);

  insert into resource_requirements (resource_id, type, value, label) values
    (r_printer, 'training', '3d_printing', '3D printing safety induction'),
    (r_printer, 'min_year', '2', '2nd year or above'),
    (r_laser,   'training', 'laser_safety', 'Laser cutter safety training'),
    (r_laser,   'min_year', '2', '2nd year or above'),
    (r_scope,   'training', 'electronics_lab', 'Electronics lab safety induction'),
    (r_hall,    'faculty_sponsor', 'course', 'Faculty-coordinated event or course'),
    (r_camera,  'min_year', '2', '2nd year or above'),
    (r_drone,   'training', 'drone_rules', 'Drone flying rules briefing');

  -- Opening hours (0 = Sunday). The printer has none (24x7 card access). Scope: Mon-Sat 08:00-22:00; laser 09:00-17:00;
  -- hall: Mon-Fri 09:00-20:00; workshop after hours 16:00-22:00
  insert into availability_rules (resource_id, weekday, opens_at, closes_at)
  select r, d, o::time, c::time from (values
    (r_scope, '08:00', '22:00'), (r_laser, '09:00', '17:00'),
    (r_lab, '16:00', '22:00'), (r_hall, '09:00', '20:00')) v(r, o, c)
  cross join generate_series(1, 6) d
  where not (v.r = r_hall and d = 6);
  insert into availability_rules (resource_id, blackout_date, note)
  values (r_hall, (now() at time zone v_tz)::date + 9, 'Reserved for the annual tech fest');

  insert into fairness_policies (resource_id, max_bookings_per_week, max_minutes_per_week, cooldown_hours, first_timer_priority, max_open_strikes) values
    (r_printer, 3, 360, 0, true, 3),
    (r_laser,   2, 180, 24, true, 3),
    (r_camera,  2, 1440, 24, true, 2);
  insert into fairness_policies (department_id, max_bookings_per_week, max_minutes_per_week) values
    (d_ece, 4, 600), (d_cse, 3, 480), (d_me, 3, 480);

  -- Qualifications ------------------------------------------------------------
  insert into user_qualifications (user_id, training_tag, evidence_path, status, verified_by, verified_at, decision_reason, expires_at, created_at) values
    (u_aarav, 'electronics_lab', u_aarav || '/electronics-induction.png', 'verified', u_rao, now() - interval '40 days', 'Attended the August induction', (now() + interval '300 days')::date, now() - interval '41 days'),
    (u_isha,  '3d_printing',     u_isha  || '/3dp-induction.png',         'verified', u_mehta, now() - interval '60 days', 'Induction batch 3', (now() + interval '200 days')::date, now() - interval '61 days'),
    (u_kabir, '3d_printing',     u_kabir || '/3dp-induction.png',         'verified', u_mehta, now() - interval '20 days', 'Induction batch 4', (now() + interval '250 days')::date, now() - interval '21 days'),
    (u_kabir, 'drone_rules',     u_kabir || '/drone-briefing.png',        'pending',  null, null, null, null, now() - interval '2 hours');

  -- Bookings, inserted directly with history so the demo has a past --------------

  -- Isha: two closed printer sessions earlier this week (puts her at 4 h of 6 h)
  insert into bookings (resource_id, user_id, during, purpose, status, decision_reason, decided_by, decided_at, checked_in_at, returned_at, closed_at, allocation_explanation, created_at)
  values (r_printer, u_isha, tstzrange(v_today - interval '2 days' + interval '10 hours', v_today - interval '2 days' + interval '12 hours'),
          'Printing gearbox housing for the BAJA SAE team prototype', 'closed', 'Condition matches the return record', u_mehta,
          v_today - interval '3 days', v_today - interval '2 days' + interval '10 hours', v_today - interval '2 days' + interval '12 hours',
          v_today - interval '2 days' + interval '13 hours', '{}', v_today - interval '4 days')
  returning id into b_id;
  insert into condition_records (booking_id, phase, checklist, photo_paths, notes, recorded_by, recorded_at, countersigned_by, countersigned_at) values
    (b_id, 'checkin', '[{"key":"bed","label":"Print bed clean and level","ok":true},{"key":"nozzle","label":"Nozzle free of residue","ok":true},{"key":"spool","label":"Filament spool mounted, no tangles","ok":true},{"key":"panel","label":"Display and controls respond","ok":true}]',
     array[b_id || '/' || u_isha || '/checkin-1.png'], 'All good', u_isha, v_today - interval '2 days' + interval '10 hours', u_mehta, v_today - interval '2 days' + interval '13 hours'),
    (b_id, 'return', '[{"key":"bed","label":"Print bed clean and level","ok":true},{"key":"nozzle","label":"Nozzle free of residue","ok":true},{"key":"spool","label":"Filament spool mounted, no tangles","ok":true},{"key":"panel","label":"Display and controls respond","ok":true}]',
     array[b_id || '/' || u_isha || '/return-1.png'], 'Used 140 g PLA', u_isha, v_today - interval '2 days' + interval '12 hours', u_mehta, v_today - interval '2 days' + interval '13 hours');
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, from_state, to_state, reason, created_at) values
    (u_isha, 'user', 'booking', b_id, 'request_submitted', null, 'pending_review', 'All automatic checks passed; waiting for owner review.', v_today - interval '4 days'),
    (u_mehta, 'owner', 'booking', b_id, 'approved', 'pending_review', 'approved', 'Team project, induction verified', v_today - interval '3 days'),
    (u_isha, 'user', 'booking', b_id, 'checked_in', 'approved', 'checked_in', 'All good', v_today - interval '2 days' + interval '10 hours'),
    (u_isha, 'user', 'booking', b_id, 'returned', 'checked_in', 'returned', 'Used 140 g PLA', v_today - interval '2 days' + interval '12 hours'),
    (u_mehta, 'owner', 'booking', b_id, 'return_confirmed', 'returned', 'closed', 'Condition matches the return record', v_today - interval '2 days' + interval '13 hours');

  -- Isha: a damaged-nozzle session that went to dispute and was resolved with a strike
  insert into bookings (resource_id, user_id, during, purpose, status, decision_reason, decided_by, decided_at, checked_in_at, returned_at, closed_at, allocation_explanation, created_at)
  values (r_printer, u_isha, tstzrange(v_today - interval '1 day' + interval '14 hours', v_today - interval '1 day' + interval '16 hours'),
          'Second iteration of the gearbox housing', 'closed', 'Nozzle replaced; strike recorded for printing ABS against the room rules', u_hod,
          v_today - interval '2 days', v_today - interval '1 day' + interval '14 hours', v_today - interval '1 day' + interval '16 hours',
          v_today - interval '1 day' + interval '18 hours', '{}', v_today - interval '3 days')
  returning id into b_id;
  insert into condition_records (booking_id, phase, checklist, photo_paths, notes, recorded_by, recorded_at, countersigned_by, countersigned_at) values
    (b_id, 'checkin', '[{"key":"bed","label":"Print bed clean and level","ok":true},{"key":"nozzle","label":"Nozzle free of residue","ok":true},{"key":"spool","label":"Filament spool mounted, no tangles","ok":true},{"key":"panel","label":"Display and controls respond","ok":true}]',
     array[b_id || '/' || u_isha || '/checkin-1.png'], '', u_isha, v_today - interval '1 day' + interval '14 hours', u_hod, v_today - interval '1 day' + interval '18 hours'),
    (b_id, 'return', '[{"key":"bed","label":"Print bed clean and level","ok":true},{"key":"nozzle","label":"Nozzle free of residue","ok":false,"note":"Some residue"},{"key":"spool","label":"Filament spool mounted, no tangles","ok":true},{"key":"panel","label":"Display and controls respond","ok":true}]',
     array[b_id || '/' || u_isha || '/return-1.png'], 'Nozzle seemed partly clogged at the end', u_isha, v_today - interval '1 day' + interval '16 hours', u_hod, v_today - interval '1 day' + interval '18 hours');
  insert into incidents (booking_id, reported_by, type, severity, description, photo_paths, estimated_cost, status, resolution, strike_applied, resolved_by, resolved_at, created_at)
  values (b_id, u_mehta, 'damage', 'medium', 'Nozzle clogged with ABS residue after this session. ABS is not allowed in this room. Nozzle needs replacement.',
          array[b_id || '/' || u_mehta || '/nozzle.png'], 650, 'resolved',
          'Nozzle replaced from lab stock. Student confirmed printing ABS. One strike recorded; cost waived for a first incident.',
          true, u_hod, v_today - interval '1 day' + interval '18 hours', v_today - interval '1 day' + interval '16 hours' + interval '30 minutes');
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, from_state, to_state, reason, created_at) values
    (u_isha, 'user', 'booking', b_id, 'request_submitted', null, 'pending_review', 'All automatic checks passed; waiting for owner review.', v_today - interval '3 days'),
    (u_mehta, 'owner', 'booking', b_id, 'approved', 'pending_review', 'approved', 'Follow-up print, slot free', v_today - interval '2 days'),
    (u_isha, 'user', 'booking', b_id, 'checked_in', 'approved', 'checked_in', null, v_today - interval '1 day' + interval '14 hours'),
    (u_isha, 'user', 'booking', b_id, 'returned', 'checked_in', 'returned', 'Nozzle seemed partly clogged at the end', v_today - interval '1 day' + interval '16 hours'),
    (u_mehta, 'owner', 'booking', b_id, 'incident_opened', 'returned', 'disputed', 'Nozzle clogged with ABS residue after this session.', v_today - interval '1 day' + interval '16 hours' + interval '30 minutes'),
    (u_hod, 'manager', 'booking', b_id, 'dispute_closed', 'disputed', 'closed', 'Nozzle replaced from lab stock. Student confirmed printing ABS. One strike recorded; cost waived for a first incident.', v_today - interval '1 day' + interval '18 hours');

  -- Competing requests for the same printer slot tomorrow 15:00-17:00.
  -- Kabir is a first-time user with 0 h this week; Isha has used 4 h. The queue ranks Kabir first.
  insert into bookings (resource_id, user_id, during, purpose, course_code, status, decision_reason, allocation_explanation, created_at)
  values (r_printer, u_isha, tstzrange(v_today + interval '1 day' + interval '15 hours', v_today + interval '1 day' + interval '17 hours'),
          'Final print of the gearbox housing before the BAJA tech inspection', null, 'pending_review',
          'All automatic checks passed; waiting for owner review.', '{}', now() - interval '5 hours')
  returning id into b_id;
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, to_state, reason, created_at)
  values (u_isha, 'user', 'booking', b_id, 'request_submitted', 'pending_review', 'All automatic checks passed; waiting for owner review.', now() - interval '5 hours');
  insert into bookings (resource_id, user_id, during, purpose, course_code, status, decision_reason, allocation_explanation, created_at)
  values (r_printer, u_kabir, tstzrange(v_today + interval '1 day' + interval '15 hours', v_today + interval '1 day' + interval '17 hours'),
          'Enclosure for a soil-moisture sensor node, mini project for CSE-210', 'CSE-210', 'pending_review',
          'All automatic checks passed; waiting for owner review.', '{}', now() - interval '3 hours')
  returning id into b_id;
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, to_state, reason, created_at)
  values (u_kabir, 'user', 'booking', b_id, 'request_submitted', 'pending_review', 'All automatic checks passed; waiting for owner review.', now() - interval '3 hours');

  -- Aarav: an approved oscilloscope slot starting now, so check-in can be shown straight away
  insert into bookings (resource_id, user_id, during, purpose, course_code, status, decision_reason, decided_by, decided_at, allocation_explanation, created_at)
  values (r_scope, u_aarav, tstzrange(v_slot, v_slot + interval '2 hours'),
          'Measuring ripple on the buck converter for the power electronics lab report', 'ECE-304', 'approved',
          'Induction verified, course-linked lab work', u_rao, now() - interval '1 hour', '{}', now() - interval '2 hours')
  returning id into b_id;
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, from_state, to_state, reason, created_at) values
    (u_aarav, 'user', 'booking', b_id, 'request_submitted', null, 'pending_review', 'All automatic checks passed; waiting for owner review.', now() - interval '2 hours'),
    (u_rao, 'owner', 'booking', b_id, 'approved', 'pending_review', 'approved', 'Induction verified, course-linked lab work', now() - interval '1 hour');

  -- Kabir: two Arduino kits out on loan (pooled resource)
  insert into bookings (resource_id, user_id, during, quantity, pooled, purpose, status, decision_reason, decided_by, decided_at, checked_in_at, allocation_explanation, created_at, deposit_acknowledged)
  values (r_kits, u_kabir, tstzrange(v_today - interval '1 day' + interval '12 hours', v_today + interval '3 days' + interval '12 hours'), 2, true,
          'Hackathon prototype: parking-slot occupancy sensors', 'checked_in', 'Deposit collected', u_rao, now() - interval '2 days',
          v_today - interval '1 day' + interval '12 hours', '{}', now() - interval '3 days', true)
  returning id into b_id;
  insert into condition_records (booking_id, phase, checklist, photo_paths, notes, recorded_by, recorded_at) values
    (b_id, 'checkin', '[{"key":"board","label":"Board powers on","ok":true},{"key":"parts","label":"Component bag sealed and complete","ok":true}]',
     array[b_id || '/' || u_kabir || '/checkin-1.png'], 'Two kits, bags sealed', u_kabir, v_today - interval '1 day' + interval '12 hours');
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, from_state, to_state, reason, created_at) values
    (u_kabir, 'user', 'booking', b_id, 'request_submitted', null, 'pending_review', 'All automatic checks passed; waiting for owner review.', now() - interval '3 days'),
    (u_rao, 'owner', 'booking', b_id, 'approved', 'pending_review', 'approved', 'Deposit collected', now() - interval '2 days'),
    (u_kabir, 'user', 'booking', b_id, 'checked_in', 'approved', 'checked_in', 'Two kits, bags sealed', v_today - interval '1 day' + interval '12 hours');

  -- Kabir: camera returned yesterday, waiting for the owner to confirm the condition
  insert into bookings (resource_id, user_id, during, purpose, status, decision_reason, decided_by, decided_at, checked_in_at, returned_at, allocation_explanation, created_at)
  values (r_camera, u_kabir, tstzrange(v_today - interval '1 day' + interval '9 hours', v_today - interval '1 day' + interval '17 hours'),
          'Shooting the department orientation video for first-years', 'returned', 'Approved for the orientation shoot', u_kapoor, now() - interval '3 days',
          v_today - interval '1 day' + interval '9 hours', v_today - interval '1 day' + interval '16 hours' + interval '40 minutes', '{}', now() - interval '4 days')
  returning id into b_id;
  insert into condition_records (booking_id, phase, checklist, photo_paths, notes, recorded_by, recorded_at) values
    (b_id, 'checkin', '[{"key":"body","label":"Body free of scratches","ok":true},{"key":"lens","label":"Lens glass clean, caps on","ok":true},{"key":"battery","label":"2 batteries and charger","ok":true},{"key":"card","label":"SD card formatted","ok":true}]',
     array[b_id || '/' || u_kabir || '/checkin-1.png'], '', u_kabir, v_today - interval '1 day' + interval '9 hours'),
    (b_id, 'return', '[{"key":"body","label":"Body free of scratches","ok":true},{"key":"lens","label":"Lens glass clean, caps on","ok":true},{"key":"battery","label":"2 batteries and charger","ok":true},{"key":"card","label":"SD card formatted","ok":true}]',
     array[b_id || '/' || u_kabir || '/return-1.png'], 'Batteries charged, footage copied off', u_kabir, v_today - interval '1 day' + interval '16 hours' + interval '40 minutes');
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, from_state, to_state, reason, created_at) values
    (u_kabir, 'user', 'booking', b_id, 'request_submitted', null, 'pending_review', 'All automatic checks passed; waiting for owner review.', now() - interval '4 days'),
    (u_kapoor, 'owner', 'booking', b_id, 'approved', 'pending_review', 'approved', 'Approved for the orientation shoot', now() - interval '3 days'),
    (u_kabir, 'user', 'booking', b_id, 'checked_in', 'approved', 'checked_in', null, v_today - interval '1 day' + interval '9 hours'),
    (u_kabir, 'user', 'booking', b_id, 'returned', 'checked_in', 'returned', 'Batteries charged, footage copied off', v_today - interval '1 day' + interval '16 hours' + interval '40 minutes');

  -- Seminar hall request without a faculty course link, blocked by the automatic checks
  insert into bookings (resource_id, user_id, during, purpose, status, decision_reason, allocation_explanation, created_at)
  values (r_hall, u_aarav, tstzrange(v_today + interval '4 days' + interval '16 hours', v_today + interval '4 days' + interval '18 hours'),
          'Robotics club open meeting for first-years', 'blocked',
          'Automatic checks failed: Faculty-coordinated event or course — Add the course code of the supervising faculty',
          '{"checks":[{"key":"req:faculty_sponsor:course","group":"eligibility","label":"Faculty-coordinated event or course","ok":false,"detail":"Add the course code of the supervising faculty"}]}',
          now() - interval '1 day')
  returning id into b_id;
  insert into audit_log (actor_id, actor_role, entity, entity_id, action, to_state, reason, created_at)
  values (u_aarav, 'user', 'booking', b_id, 'request_submitted', 'blocked',
          'Automatic checks failed: Faculty-coordinated event or course — Add the course code of the supervising faculty', now() - interval '1 day');


  insert into notifications (user_id, type, title, body, created_at) values
    (u_aarav, 'welcome', 'Welcome to OpenBench', 'Your oscilloscope slot starts now. Open My bookings to check in.', now() - interval '5 minutes'),
    (u_mehta, 'review_needed', 'Two requests compete for the Prusa MK4', 'Tomorrow 15:00-17:00. The queue shows who has priority and why.', now() - interval '3 hours'),
    (u_kapoor, 'booking_returned', 'Returned: Sony A7 III Camera Kit', 'Check the return photos and confirm the condition.', now() - interval '20 hours'),
    (u_admin, 'account_pending', 'New account waiting: Riya Das', 'Verify the roll number before the account can book.', now() - interval '1 hour');

  perform set_config('openbench.seeding', 'off', true);
  return jsonb_build_object('ok', true, 'seeded_at', now(),
    'resources', (select count(*) from resources), 'bookings', (select count(*) from bookings));
end $$;

revoke execute on function seed_demo() from public, anon, authenticated;
grant execute on function seed_demo() to service_role;
