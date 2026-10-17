-- Edit only ordinary OS details. Status, customer, assignment, tracking secrets and
-- financial records keep their existing controlled paths.
grant update (brand, model, color, storage_capacity, platform, reported_issue,
  physical_condition, accessories, internal_notes) on public.work_orders to authenticated;

create policy "Staff edit applicable order details" on public.work_orders
for update to authenticated
using (public.staff_has_permission('work_orders.update') or
  (assigned_technician_id = (select auth.uid()) and public.staff_has_permission('work_orders.update_assigned')))
with check (public.staff_has_permission('work_orders.update') or
  (assigned_technician_id = (select auth.uid()) and public.staff_has_permission('work_orders.update_assigned')));

create or replace function private.audit_work_order_details()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if row(new.brand,new.model,new.color,new.storage_capacity,new.platform,new.reported_issue,new.physical_condition,new.accessories,new.internal_notes)
    is distinct from row(old.brand,old.model,old.color,old.storage_capacity,old.platform,old.reported_issue,old.physical_condition,old.accessories,old.internal_notes) then
    new.updated_at := clock_timestamp();
    if auth.uid() is not null then
      insert into public.audit_logs(actor_id,action,entity_type,entity_id,metadata)
      values(auth.uid(),'work_order.details_updated','work_order',new.id,
        jsonb_build_object('fields',(select jsonb_agg(n.key) from jsonb_each(to_jsonb(new)) n
          where n.key in ('brand','model','color','storage_capacity','platform','reported_issue','physical_condition','accessories','internal_notes')
            and n.value is distinct from to_jsonb(old)->n.key)));
      insert into public.work_order_events(work_order_id,actor_id,previous_status,new_status,public_summary,internal_notes)
      values(new.id,auth.uid(),old.status,new.status,null,'Dados da OS editados pela equipe.');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.audit_work_order_details() from public, anon, authenticated;
drop trigger if exists audit_work_order_details on public.work_orders;
create trigger audit_work_order_details before update of brand, model, color, storage_capacity,
  platform, reported_issue, physical_condition, accessories, internal_notes on public.work_orders
for each row execute function private.audit_work_order_details();

create or replace function public.edit_work_order_details(p_order_id uuid, p_expected_updated_at timestamptz, p_details jsonb)
returns table(id uuid,order_number text,updated_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Entre novamente para editar a OS.' using errcode='42501'; end if;
  if jsonb_typeof(p_details) is distinct from 'object' or p_expected_updated_at is null then
    raise exception 'Dados de edição inválidos.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_details) k where k not in
    ('brand','model','color','storage_capacity','platform','reported_issue','physical_condition','accessories','internal_notes')) then
    raise exception 'Campo não permitido para edição.' using errcode='22023';
  end if;
  if nullif(btrim(p_details->>'brand'),'') is null or length(btrim(p_details->>'brand'))>80
    or nullif(btrim(p_details->>'model'),'') is null or length(btrim(p_details->>'model'))>120
    or nullif(btrim(p_details->>'reported_issue'),'') is null or length(btrim(p_details->>'reported_issue'))>4000
    or length(coalesce(p_details->>'physical_condition',''))>3000
    or length(coalesce(p_details->>'internal_notes',''))>3000
    or length(coalesce(p_details->>'color',''))>80
    or length(coalesce(p_details->>'storage_capacity',''))>80 then
    raise exception 'Revise marca, modelo, problema e os limites dos campos.' using errcode='22023';
  end if;
  if coalesce(p_details->>'platform','') not in ('','android','iphone','other')
    or jsonb_typeof(p_details->'accessories') is distinct from 'array' then
    raise exception 'Sistema ou acessórios inválidos.' using errcode='22023';
  end if;
  if jsonb_array_length(p_details->'accessories')>50 or exists(
    select 1 from jsonb_array_elements(p_details->'accessories') v
      where jsonb_typeof(v) is distinct from 'string' or length(v#>>'{}')>160) then
    raise exception 'Revise a lista de acessórios.' using errcode='22023';
  end if;
  return query update public.work_orders w set
    brand=btrim(p_details->>'brand'),model=btrim(p_details->>'model'),
    color=nullif(btrim(p_details->>'color'),''),storage_capacity=nullif(btrim(p_details->>'storage_capacity'),''),
    platform=nullif(p_details->>'platform',''),reported_issue=btrim(p_details->>'reported_issue'),
    physical_condition=coalesce(p_details->>'physical_condition',''),internal_notes=nullif(p_details->>'internal_notes',''),
    accessories=array(select jsonb_array_elements_text(p_details->'accessories'))
    where w.id=p_order_id and w.updated_at=p_expected_updated_at
    returning w.id,w.order_number,w.updated_at;
  if not found then
    raise exception 'A OS foi alterada em outra sessão ou você não tem permissão. Feche e abra a edição novamente.' using errcode='40001';
  end if;
end;
$$;
revoke all on function public.edit_work_order_details(uuid,timestamptz,jsonb) from public,anon;
grant execute on function public.edit_work_order_details(uuid,timestamptz,jsonb) to authenticated;
