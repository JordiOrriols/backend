begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(9);

select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.pulse_actions'::regclass, 'public.pulse_action_collaborators'::regclass,
  'public.pulse_action_updates'::regclass)),
  'every Pulse action table enforces RLS');
select ok(not has_table_privilege('authenticated', 'public.pulse_actions', 'select'), 'actions are read through list_pulse_actions');
select ok(not has_table_privilege('authenticated', 'public.pulse_actions', 'update'), 'statuses only move through the RPCs, which keep the history');
select ok(not has_table_privilege('authenticated', 'public.pulse_action_updates', 'insert'), 'nobody writes history by hand');
select ok(not has_function_privilege('anon', 'public.list_pulse_actions(uuid)', 'execute'), 'anonymous visitors cannot list actions');
select ok(not has_function_privilege('anon', 'public.pulse_workspace_people(uuid)', 'execute'), 'anonymous visitors cannot list accounts');
select ok(not has_function_privilege('authenticated', 'public.pulse_action_for(uuid)', 'execute'), 'internal helpers stay private');
select ok(not has_function_privilege('authenticated', 'public.pulse_set_action_people(public.pulse_actions,uuid,uuid[])', 'execute'), 'people are only set through create and update');
select is(public.pulse_retro_stages(), array['prepare', 'collect', 'group', 'vote', 'discuss', 'actions', 'closed'],
  'retros agree on actions before closing');

select * from finish();
rollback;
