\set ON_ERROR_STOP on
begin;
do $$
declare actor uuid;
begin
  select user_id into actor from public.staff_profiles where active and role='admin' limit 1;
  if actor is null then raise exception 'An active administrator is required for the editing integration check'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
end $$;
set local role authenticated;
do $$
declare w public.work_orders; d jsonb; changed record;
begin
  select * into w from public.work_orders order by received_at limit 1;
  if not found then raise notice 'No work orders: runtime edit check skipped'; return; end if;
  d:=jsonb_build_object('brand',w.brand,'model',w.model,'color',w.color,'storage_capacity',w.storage_capacity,
    'platform',w.platform,'reported_issue','Verificação transacional de edição.','physical_condition',w.physical_condition,
    'accessories',to_jsonb(w.accessories),'internal_notes',w.internal_notes);
  select * into changed from public.edit_work_order_details(w.id,w.updated_at,d);
  if changed.id is distinct from w.id or changed.updated_at<=w.updated_at then raise exception 'Edit did not persist'; end if;
  if not exists(select 1 from public.audit_logs where entity_id=w.id and action='work_order.details_updated' and actor_id=auth.uid()) then raise exception 'Audit missing'; end if;
  begin
    perform public.edit_work_order_details(w.id,w.updated_at,d);
    raise exception 'Stale edits were accepted';
  exception when serialization_failure then null; end;
  begin
    perform public.edit_work_order_details(w.id,changed.updated_at,d||'{"status":"delivered"}'::jsonb);
    raise exception 'Protected fields were accepted';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
do $$ begin perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true); end $$;
set local role authenticated;
do $$ begin
  if exists(select 1 from public.work_orders) then raise exception 'Unknown staff could see orders'; end if;
  if has_column_privilege(current_user,'public.work_orders','status','UPDATE') then raise exception 'Unrestricted status update grant'; end if;
end $$;
reset role;
do $$ begin
  if has_function_privilege('anon','public.edit_work_order_details(uuid,timestamptz,jsonb)','EXECUTE') then raise exception 'Anonymous edit exposed'; end if;
end $$;
rollback;
\echo 'Order editing, optimistic concurrency, audit and permissions verified; all test changes rolled back.'
