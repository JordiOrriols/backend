create table platform.pulse_participations (
  survey_id uuid not null references public.pulse_surveys(id) on delete cascade,
  user_id uuid not null references platform.users(id),
  primary key(survey_id,user_id)
);
revoke all on platform.pulse_participations from public,anon,authenticated,service_role,platform_api;

create function platform.pulse_require_access(account uuid, workspace uuid, editing boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from platform.grants g where g.user_id=account and g.workspace_id=workspace
    and g.app='pulse' and (g.role in ('owner','editor') or (not editing and g.role='viewer'))
    for share;
  if not found then raise exception 'Pulse workspace access required' using errcode='42501'; end if;
end;
$$;

create function platform.pulse_surveys(account uuid, workspace uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform platform.pulse_require_access(account,workspace);
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',s.id,'title',s.title,'asks_comment',s.asks_comment,'min_responses',s.min_responses,
    'status',s.status,'created_at',s.created_at,'closed_at',s.closed_at,
    'answered',exists(select 1 from platform.pulse_participations p where p.survey_id=s.id and p.user_id=account)
      or exists(select 1 from public.pulse_participations p join platform.legacy_account_mappings l
        on l.legacy_user_id=p.user_id where l.user_id=account and p.survey_id=s.id),
    'pulse_questions',coalesce((select jsonb_agg(jsonb_build_object(
      'id',q.id,'position',q.position,'key',q.key,'prompt',q.prompt,
      'low_label',q.low_label,'high_label',q.high_label
    ) order by q.position) from public.pulse_questions q where q.survey_id=s.id),'[]'::jsonb)
  ) order by s.created_at desc,s.id) from public.pulse_surveys s where s.workspace_id=workspace),'[]'::jsonb);
end;
$$;

create function platform.pulse_survey_results(account uuid, workspace uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare participants integer;
begin
  perform platform.pulse_require_access(account,workspace);
  select count(*) into participants from platform.grants g where g.workspace_id=workspace
    and g.app='pulse' and g.role in ('owner','editor','viewer');
  return coalesce((select jsonb_agg(jsonb_build_object(
    'survey_id',s.id,'responses',counted.total,'participants',participants,'visible',shown.ok,
    'distribution',case when shown.ok then coalesce((
      select jsonb_object_agg(q.id::text,(
        select jsonb_build_array(
          count(*) filter(where a.rating=1),count(*) filter(where a.rating=2),
          count(*) filter(where a.rating=3),count(*) filter(where a.rating=4),
          count(*) filter(where a.rating=5))
        from public.pulse_answers a where a.question_id=q.id
      )) from public.pulse_questions q where q.survey_id=s.id
    ),'{}'::jsonb) else '{}'::jsonb end,
    'comments',case when shown.ok then coalesce((
      select jsonb_agg(c.body order by c.body) from public.pulse_comments c where c.survey_id=s.id
    ),'[]'::jsonb) else '[]'::jsonb end
  ) order by s.created_at,s.id) from public.pulse_surveys s
    cross join lateral(select count(*)::integer total from public.pulse_responses r where r.survey_id=s.id) counted
    cross join lateral(select s.status='closed' and counted.total>=s.min_responses ok) shown
    where s.workspace_id=workspace),'[]'::jsonb);
end;
$$;

create function platform.pulse_create_survey(account uuid, workspace uuid, content jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved uuid; item jsonb; ordinal integer:=0;
begin
  perform platform.pulse_require_access(account,workspace,true);
  perform id from public.workspaces where id=workspace for update;
  if content is null or jsonb_typeof(content)<>'object'
    or content->>'title' is null or char_length(trim(content->>'title')) not between 1 and 120
    or jsonb_typeof(content->'asks_comment') is distinct from 'boolean'
    or jsonb_typeof(content->'min_responses') is distinct from 'number'
    or (content->>'min_responses') !~ '^[0-9]+$'
    or (content->>'min_responses')::numeric not between 1 and 50
    or jsonb_typeof(content->'questions') is distinct from 'array' then
    raise exception 'Invalid survey content' using errcode='22023';
  end if;
  if jsonb_array_length(content->'questions') not between 1 and 12 then
    raise exception 'Surveys need between 1 and 12 questions' using errcode='22023';
  end if;
  insert into public.pulse_surveys(workspace_id,title,asks_comment,min_responses)
    values(workspace,trim(content->>'title'),(content->>'asks_comment')::boolean,
      (content->>'min_responses')::smallint) returning id into saved;
  for item in select value from jsonb_array_elements(content->'questions') loop
    if jsonb_typeof(item)<>'object' or
      not ((item->>'key' is not null) <> (nullif(trim(item->>'prompt'),'') is not null))
      or (item->>'key' is not null and item->>'key' not in ('health','delivery','autonomy','clarity','workload','collaboration'))
      or (item->>'prompt' is not null and char_length(trim(item->>'prompt')) not between 1 and 200)
      or (item->>'low_label' is not null and char_length(trim(item->>'low_label')) not between 1 and 40)
      or (item->>'high_label' is not null and char_length(trim(item->>'high_label')) not between 1 and 40) then
      raise exception 'Invalid survey question' using errcode='22023';
    end if;
    ordinal:=ordinal+1;
    insert into public.pulse_questions(survey_id,position,key,prompt,low_label,high_label)
      values(saved,ordinal,item->>'key',nullif(trim(item->>'prompt'),''),
        nullif(trim(item->>'low_label'),''),nullif(trim(item->>'high_label'),''));
  end loop;
  return jsonb_build_object('id',saved);
end;
$$;

create function platform.pulse_submit_response(account uuid, workspace uuid, survey uuid, ratings jsonb, comment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target public.pulse_surveys; response uuid; legacy uuid;
begin
  perform platform.pulse_require_access(account,workspace);
  select l.legacy_user_id into legacy from platform.legacy_account_mappings l where l.user_id=account for share;
  perform id from public.workspaces where id=workspace for update;
  select s.* into target from public.pulse_surveys s where s.id=survey and s.workspace_id=workspace for update;
  if not found then raise exception 'Survey unavailable in this workspace' using errcode='P0002'; end if;
  if target.status<>'open' then raise exception 'This survey is closed' using errcode='23514'; end if;
  if ratings is null or jsonb_typeof(ratings)<>'object' then
    raise exception 'Rate every question from 1 to 5' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_each(ratings) r where
      not exists(select 1 from public.pulse_questions q where q.survey_id=survey and q.id::text=r.key)
      or jsonb_typeof(r.value)<>'number' or r.value::text not in ('1','2','3','4','5'))
    or exists(select 1 from public.pulse_questions q where q.survey_id=survey and not ratings ? q.id::text)
    or comment is null or char_length(trim(comment))>2000 then
    raise exception 'Rate every question from 1 to 5; comments allow at most 2000 characters' using errcode='22023';
  end if;
  if exists(select 1 from platform.pulse_participations p where p.survey_id=survey and p.user_id=account)
    or exists(select 1 from public.pulse_participations p where p.survey_id=survey and p.user_id=legacy) then
    raise exception 'You already answered this survey' using errcode='23514';
  end if;
  insert into platform.pulse_participations(survey_id,user_id) values(survey,account);
  if legacy is not null then
    insert into public.pulse_participations(survey_id,user_id) values(survey,legacy);
  end if;
  insert into public.pulse_responses(survey_id) values(survey) returning id into response;
  insert into public.pulse_answers(response_id,question_id,rating)
    select response,r.key::uuid,r.value::text::smallint from jsonb_each(ratings) r;
  if target.asks_comment and length(trim(comment))>0 then
    insert into public.pulse_comments(survey_id,body) values(survey,trim(comment));
  end if;
  return jsonb_build_object('id',survey);
end;
$$;

create function platform.pulse_manage_survey(account uuid, workspace uuid, survey uuid, action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform platform.pulse_require_access(account,workspace,true);
  perform id from public.workspaces where id=workspace for update;
  perform 1 from public.pulse_surveys s where s.id=survey and s.workspace_id=workspace for update;
  if not found then raise exception 'Survey unavailable in this workspace' using errcode='P0002'; end if;
  if action='delete' then
    delete from public.pulse_surveys where id=survey;
  elsif action in ('open','closed') then
    update public.pulse_surveys set status=action,closed_at=case when action='closed' then now() end where id=survey;
  else raise exception 'Invalid survey action' using errcode='22023'; end if;
  return jsonb_build_object('id',survey);
end;
$$;

revoke all on function platform.pulse_require_access(uuid,uuid,boolean),
  platform.pulse_surveys(uuid,uuid),platform.pulse_survey_results(uuid,uuid),
  platform.pulse_create_survey(uuid,uuid,jsonb),platform.pulse_submit_response(uuid,uuid,uuid,jsonb,text),
  platform.pulse_manage_survey(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,platform_api;
grant execute on function platform.pulse_surveys(uuid,uuid),platform.pulse_survey_results(uuid,uuid),
  platform.pulse_create_survey(uuid,uuid,jsonb),platform.pulse_submit_response(uuid,uuid,uuid,jsonb,text),
  platform.pulse_manage_survey(uuid,uuid,uuid,text) to platform_api;
