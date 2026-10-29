-- Local tests only: create the demo auth users the way the Supabase admin API would.
insert into auth.users (email, raw_user_meta_data) values
  ('admin@demo.openbench.in', '{"full_name":"Admin"}'),
  ('hod.sharma@demo.openbench.in', '{"full_name":"HOD"}'),
  ('prof.mehta@demo.openbench.in', '{"full_name":"Mehta"}'),
  ('dr.rao@demo.openbench.in', '{"full_name":"Rao"}'),
  ('ms.kapoor@demo.openbench.in', '{"full_name":"Kapoor"}'),
  ('aarav@demo.openbench.in', '{"full_name":"Aarav"}'),
  ('isha@demo.openbench.in', '{"full_name":"Isha"}'),
  ('kabir@demo.openbench.in', '{"full_name":"Kabir"}'),
  ('newstudent@demo.openbench.in', '{"full_name":"Riya"}');
update app_settings set demo_mode = true, storage_base = 'http://localhost:54321';
select seed_demo();
