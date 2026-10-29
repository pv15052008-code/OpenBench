# Deploying OpenBench

Everything runs on free tiers. Order matters: database first, then the API, then the app.

## 1. Supabase (database, auth, storage)

1. Create a project at supabase.com. Region: Mumbai (ap-south-1).
2. **SQL Editor**: run the files in `supabase/migrations/` in order, `0001` to `0006`. Each must finish without errors.
3. **Authentication → Sign In / Providers → Email**: keep email sign-up on. For a demo, you may turn off "Confirm email" so new accounts can sign in at once.
4. Optional: limit sign-up to your college domain:
   ```sql
   update app_settings set allowed_email_domains = '{your-college.edu.in}';
   ```
   Keep `demo.openbench.in` in the list if you also want the demo accounts: `'{your-college.edu.in,demo.openbench.in}'`.
5. **Project Settings → API**: copy the Project URL, the `anon` key and the `service_role` key. The service-role key is a secret: it goes only into Render and your terminal, never the app or the repo.
6. Tell the database its own address, so listing photos are accepted only from this project's storage (the demo seed does this for you):
   ```sql
   update app_settings set storage_base = 'https://xyz.supabase.co';
   ```
7. Register your real courses and trainings (or let the demo seed create sample ones):
   ```sql
   insert into courses (code, name, department_id) select 'ECE-304', 'Power Electronics Lab', id from departments where code = 'ECE';
   ```
   A new training is registered when a department manager first adds it as a requirement on one of the department's listings; it belongs to that department, and only that department's staff can verify certificates for it.
8. Seed the demo (this turns on demo mode, which allows the admin's "Reset demo data" button; never do this on a real deployment):
   ```bash
   cd scripts && npm ci
   SUPABASE_URL=https://xyz.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npm run seed
   ```

## 2. Engine API on Render

1. render.com → New → Blueprint → pick this repo. It reads `render.yaml`.
2. Fill in the environment variables marked `sync: false` (see `services/api/.env.example`). `ALLOWED_ORIGINS` must include your Vercel URL.
3. Note the service URL, e.g. `https://openbench-api.onrender.com`, and the generated `CRON_SECRET`.
4. Check `https://openbench-api.onrender.com/health` returns `"ok": true`.

## 3. Scheduled sweep (GitHub Actions)

Repo → Settings → Secrets and variables → Actions → add `API_URL` and `CRON_SECRET`. The `cron` workflow then runs every 10 minutes: it marks no-shows and overdue returns, sends emails, and keeps the free Render instance from sleeping during judging.

## 4. Web app on Vercel

1. vercel.com → Add New Project → this repo → **Root Directory: `apps/mobile`**. `vercel.json` sets the build.
2. Environment variables: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_API_URL`.
3. Deploy. Add the Vercel URL to Supabase **Authentication → URL Configuration → Site URL** and to the API's `ALLOWED_ORIGINS`.

## 5. Android APK and iOS

```bash
cd apps/mobile
npx eas-cli@latest login
npx eas-cli@latest init                         # links the project
npx eas-cli@latest env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://xyz.supabase.co --environment preview
npx eas-cli@latest env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value ... --environment preview
npx eas-cli@latest env:create --name EXPO_PUBLIC_API_URL --value https://openbench-api.onrender.com --environment preview
npx eas-cli@latest build --platform android --profile preview    # produces an installable APK link
```

iPhone without an Apple developer account: run `npx expo start --tunnel` and share the QR code for Expo Go. With an account ($99/year), `eas build --platform ios` then `eas submit` to TestFlight.

## During judging

- Open the Supabase dashboard every few days: free projects pause after a week without activity.
- Admin → Reset demo data restores the starting state if judges leave things half-done.
