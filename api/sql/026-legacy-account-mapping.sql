create table platform.legacy_account_mappings (
  user_id uuid primary key references platform.users(id) on delete cascade,
  legacy_user_id uuid not null unique references auth.users(id),
  created_at timestamptz not null default now()
);

revoke all on platform.legacy_account_mappings
  from public, anon, authenticated, service_role, platform_api;
