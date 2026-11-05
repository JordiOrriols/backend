begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;
select plan(9);

select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.pulse_surveys'::regclass, 'public.pulse_questions'::regclass, 'public.pulse_participations'::regclass,
  'public.pulse_responses'::regclass, 'public.pulse_answers'::regclass, 'public.pulse_comments'::regclass)),
  'every Pulse survey table enforces RLS');
select ok(not has_table_privilege('authenticated', 'public.pulse_responses', 'select'), 'responses are only read in aggregate');
select ok(not has_table_privilege('authenticated', 'public.pulse_answers', 'select'), 'ratings are only read in aggregate');
select ok(not has_table_privilege('authenticated', 'public.pulse_comments', 'select'), 'comments are only read through results');
select ok(not has_table_privilege('authenticated', 'public.pulse_surveys', 'insert'), 'surveys are created through the RPC');
select ok(not has_table_privilege('authenticated', 'public.pulse_participations', 'insert'), 'participation is only recorded with a response');
select hasnt_column('public', 'pulse_responses', 'user_id', 'responses keep no account');
select hasnt_column('public', 'pulse_responses', 'created_at', 'responses keep no time');
select ok(not has_function_privilege('anon', 'public.submit_pulse_response(uuid,jsonb,text)', 'execute'), 'anonymous visitors cannot answer');

select * from finish();
rollback;
