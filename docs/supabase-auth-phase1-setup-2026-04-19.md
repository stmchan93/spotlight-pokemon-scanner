# Supabase Auth Phase 1 Setup

This app-side implementation adds:

- Sign in with Apple
- Google sign-in through Supabase OAuth
- session restore
- profile onboarding
- account sheet + sign out

The Python scanner/pricing backend stays unchanged in this phase.

## 1. Create `user_profiles`

Run this in Supabase SQL:

```sql
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_user_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;

create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row execute function public.touch_user_profiles_updated_at();

alter table public.user_profiles enable row level security;

create policy "user_profiles_select_own"
on public.user_profiles
for select
to authenticated
using (auth.uid() = user_id);

create policy "user_profiles_insert_own"
on public.user_profiles
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "user_profiles_update_own"
on public.user_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
```

The app also falls back to auth user metadata if this table is missing, but the intended phase-1 setup includes the table.

## 2. Enable providers

In Supabase Auth providers:

- enable `Google`
- enable `Apple`

### Google

Google still redirects to Supabase first, not directly to the app.

Use the redirect URI Supabase gives you in the provider setup, typically:

```text
https://<your-project-ref>.supabase.co/auth/v1/callback
```

### Apple

Use Sign in with Apple in Supabase and configure the same Supabase callback URL there too.

## 3. Add the mobile redirect URL to Supabase

In Supabase Auth URL configuration, allow this redirect:

```text
com.app.LootyCards://login-callback
```

If you change the bundle id or `SPOTLIGHT_AUTH_REDIRECT_HOST`, update this too.

## 4. Fill local app config

Copy:

```text
Spotlight/Config/LocalOverrides.example.xcconfig
```

to:

```text
Spotlight/Config/LocalOverrides.xcconfig
```

Then set:

```xcconfig
SPOTLIGHT_SUPABASE_URL = https://<your-project-ref>.supabase.co
SPOTLIGHT_SUPABASE_ANON_KEY = <your-anon-key>
```

Optional:

```xcconfig
SPOTLIGHT_AUTH_REDIRECT_HOST = login-callback
```

## 5. Xcode capability

The project now includes:

- `Spotlight/Resources/Spotlight.entitlements`
- `com.apple.developer.applesignin = Default`

If Xcode asks you to confirm the capability in Signing & Capabilities, accept it.

## 6. Current phase-1 behavior

- auth gates the shell before scanner/portfolio/dashboard
- scanner + pricing API calls still go to the current Python backend
- auth does not yet isolate deck/portfolio data by user
- phase 2 is where `owner_user_id` and backend JWT verification would land
