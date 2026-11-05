begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

select ok(not has_function_privilege('anon', 'public.self_delete(uuid,uuid)', 'execute'), 'anonymous self deletion denied');
select ok(not has_function_privilege('authenticated', 'public.self_delete(uuid,uuid)', 'execute'), 'signed-in self deletion denied');
select ok((select relrowsecurity from pg_class where oid = 'public.smart_goals'::regclass), 'goals enforce RLS');
select ok(to_regprocedure('public.token_goal_create(uuid,text,text,date,smallint,text)') is null, 'obsolete goal creation removed');
select ok(to_regprocedure('public.token_goal_update(uuid,uuid,text,text,date,smallint,text)') is null, 'obsolete unrestricted update removed');
select ok(to_regprocedure('public.token_goal_delete(uuid,uuid)') is null, 'obsolete goal deletion removed');
select ok(not has_column_privilege('authenticated', 'public.smart_goals', 'comments', 'update'), 'comment history cannot be replaced');
select ok(not has_column_privilege('authenticated', 'public.smart_goals', 'comments', 'insert'), 'saved history cannot be forged on insert');
select throws_ok($$select public.view_goal_progress('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 50)$$, '28000', 'invalid view link', 'invalid link cannot change progress');
select throws_ok($$select public.view_sharing_links('00000000-0000-0000-0000-000000000001')$$, '28000', 'invalid view link', 'invalid link cannot discover tokens');

select * from finish();
rollback;