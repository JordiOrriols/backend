begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(8);

select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.pulse_retros'::regclass, 'public.pulse_retro_groups'::regclass,
  'public.pulse_retro_topics'::regclass, 'public.pulse_retro_votes'::regclass)),
  'every Pulse retrospective table enforces RLS');
select ok(not has_table_privilege('authenticated', 'public.pulse_retro_topics', 'select'), 'topics are only read through the board, which hides authors');
select ok(not has_table_privilege('authenticated', 'public.pulse_retro_votes', 'select'), 'votes are only read as totals');
select ok(not has_table_privilege('authenticated', 'public.pulse_retro_groups', 'select'), 'groups are only read through the board');
select ok(not has_table_privilege('authenticated', 'public.pulse_retros', 'insert'), 'retros are created through the RPC');
select ok(not has_table_privilege('authenticated', 'public.pulse_retros', 'update'), 'stages only move through the RPC');
select ok(not has_function_privilege('anon', 'public.pulse_retro_board(uuid)', 'execute'), 'anonymous visitors cannot read a board');
select ok(not has_function_privilege('authenticated', 'public.pulse_retro_for(uuid,boolean)', 'execute'), 'internal helpers stay private');

select * from finish();
rollback;
