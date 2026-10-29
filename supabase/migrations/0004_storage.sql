-- OpenBench · 0004 storage buckets and policies
-- Path conventions (enforced here and again inside the RPCs):
--   resource-photos   <owner_id>/<file>                 public read, owners write
--   condition-photos  <booking_id>/<user_id>/<file>     parties of the booking read, uploader writes
--   incident-photos   <booking_id>/<user_id>/<file>     parties of the booking read, uploader writes
--   eligibility-docs  <user_id>/<file>                  the user and their verifiers read, the user writes

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('resource-photos',  'resource-photos',  true,  5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('condition-photos', 'condition-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp']),
  ('incident-photos',  'incident-photos',  false, 8388608, array['image/jpeg', 'image/png', 'image/webp']),
  ('eligibility-docs', 'eligibility-docs', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Safe uuid parse: a malformed folder name must not throw inside a policy
create or replace function public._try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- Can the caller read a file under <booking_id>/...?
create or replace function public._can_read_booking_file(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.can_view_booking(public._try_uuid((storage.foldername(p_name))[1])), false)
$$;

-- Can the caller upload to <booking_id>/<me>/...? Only a party to an active booking.
create or replace function public._can_write_booking_file(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (storage.foldername(p_name))[2] = auth.uid()::text
     and array_length(storage.foldername(p_name), 1) = 2
     and exists (select 1 from public.bookings b
                 where b.id = public._try_uuid((storage.foldername(p_name))[1])
                   and public.can_view_booking(b.id)
                   and b.status in ('approved', 'checked_in', 'overdue', 'returned', 'closed', 'disputed', 'no_show'))
$$;

create or replace function public._can_read_eligibility_file(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (storage.foldername(p_name))[1] = auth.uid()::text
      or exists (select 1 from public.user_qualifications q
                 where q.evidence_path = p_name and public._can_verify_qualification(q))
$$;

revoke execute on function public._try_uuid(text), public._can_read_booking_file(text),
  public._can_write_booking_file(text), public._can_read_eligibility_file(text) from public, anon;
grant execute on function public._try_uuid(text), public._can_read_booking_file(text),
  public._can_write_booking_file(text), public._can_read_eligibility_file(text) to authenticated;

-- Resource photos: anyone can view (bucket is public); verified owners upload to their own folder
create policy "resource photos: owners upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'resource-photos'
              and (storage.foldername(name))[1] = auth.uid()::text
              and exists (select 1 from public.profiles p where p.id = auth.uid()
                          and p.role in ('owner', 'manager', 'admin') and p.verification_status = 'verified'));
create policy "resource photos: owners delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'resource-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Condition and incident photos: write once, never overwritten or deleted by clients
create policy "booking photos: party uploads" on storage.objects for insert to authenticated
  with check (bucket_id in ('condition-photos', 'incident-photos') and public._can_write_booking_file(name));
create policy "booking photos: parties read" on storage.objects for select to authenticated
  using (bucket_id in ('condition-photos', 'incident-photos') and public._can_read_booking_file(name));

-- Eligibility documents
create policy "eligibility docs: user uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'eligibility-docs' and (storage.foldername(name))[1] = auth.uid()::text
              and array_length(storage.foldername(name), 1) = 1);
create policy "eligibility docs: user and verifiers read" on storage.objects for select to authenticated
  using (bucket_id = 'eligibility-docs' and public._can_read_eligibility_file(name));
