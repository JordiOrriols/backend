-- Agents: the runner reports the model and tokens of the run in progress, so the app can show
-- them before the run finishes. The live counters only mean something while a task is running;
-- agents_finish_task keeps adding the final figures to the totals, and the runner resets the
-- counters when it starts a run.
alter table public.agent_tasks
  add column live_tokens_generated bigint not null default 0,
  add column live_tokens_total bigint not null default 0;

create function public.agents_report_progress(task uuid, runner_name text, run_model text,
  run_tokens_generated bigint, run_tokens_total bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare found_task public.agent_tasks := public.agents_lock_task(task);
begin
  if found_task.status <> 'running' or found_task.runner is distinct from btrim(runner_name) then
    raise exception 'Task is not running on this runner' using errcode = '55000';
  end if;
  update public.agent_tasks t set
      model = coalesce(nullif(left(run_model, 200), ''), t.model),
      live_tokens_generated = greatest(coalesce(run_tokens_generated, 0), 0),
      live_tokens_total = greatest(coalesce(run_tokens_total, 0), 0)
    where t.id = task;
end;
$$;

revoke all on function public.agents_report_progress(uuid, text, text, bigint, bigint) from public, anon;
grant execute on function public.agents_report_progress(uuid, text, text, bigint, bigint) to authenticated;
