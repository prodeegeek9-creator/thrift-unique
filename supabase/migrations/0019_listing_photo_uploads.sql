-- Photos uploaded from the dashboard's product form.
--
-- 0011 left the bucket closed to every client role, because the only writer
-- was the Worker. The dashboard now has a manual "Add product" form, so the
-- team gets the insert policy 0011 described: into its own store's folder and
-- nowhere else. The first path segment is the tenant id (see storagePath() in
-- worker/lib/media.js and src/lib/uploads.js), and every member role may list
-- items, matching the products policy.
--
-- Insert only. No update, so an existing photo cannot be overwritten under a
-- live listing; no delete, so a removed photo simply stops being referenced.
create policy "team uploads listing photos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] in (
      select id::text from public.current_tenant_ids() as id
    )
  );
