create schema platform;

create table platform.users (
  id uuid primary key default gen_random_uuid(),
  email text not null
);

create table platform.identities (
  issuer text not null,
  subject text not null,
  user_id uuid not null references platform.users(id),
  primary key (issuer, subject)
);

create table platform.grants (
  user_id uuid not null references platform.users(id),
  app text not null check (app in ('planner','shiplog','ladders','pulse','agents')),
  workspace_id uuid not null references public.workspaces(id),
  role text not null check (role in ('owner','editor','viewer','external')),
  primary key (user_id, app, workspace_id),
  check (role <> 'external' or app in ('planner','shiplog'))
);

create role platform_api login;
grant usage on schema platform to platform_api;
grant select, insert, update on platform.users to platform_api;
grant select, insert on platform.identities to platform_api;
grant select on platform.grants to platform_api;
