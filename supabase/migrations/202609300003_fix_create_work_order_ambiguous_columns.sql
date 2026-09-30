begin;

create or replace function public.create_work_order_atomic(
  customer_data jsonb,
  order_data jsonb,
  tracking_hash text,
  secret_ciphertext text default null,
  secret_iv text default null
)
returns table (id uuid, order_number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_new_order_id uuid;
  v_new_order_number text;
  v_assigned_technician uuid;
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not public.staff_has_permission('work_orders.create') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select case
           when sp.role = 'technician' then sp.user_id
           else null
         end
    into v_assigned_technician
    from public.staff_profiles as sp
   where sp.user_id = v_actor
     and sp.active = true;

  if nullif(customer_data->>'id', '') is not null then
    select c.id
      into v_customer_id
      from public.customers as c
     where c.id = (customer_data->>'id')::uuid;

    if v_customer_id is null then
      raise exception 'customer not found' using errcode = 'P0002';
    end if;

    update public.customers as c
       set cpf = nullif(customer_data->>'cpf', '')
     where c.id = v_customer_id
       and c.cpf is null
       and nullif(customer_data->>'cpf', '') is not null;
  else
    insert into public.customers(name, whatsapp, email, cpf)
    values (
      customer_data->>'name',
      customer_data->>'whatsapp',
      nullif(customer_data->>'email', ''),
      nullif(customer_data->>'cpf', '')
    )
    returning public.customers.id into v_customer_id;
  end if;

  insert into public.work_orders(
    customer_id,
    assigned_technician_id,
    brand,
    model,
    color,
    storage_capacity,
    platform,
    lock_type,
    reported_issue,
    physical_condition,
    accessories,
    internal_notes,
    public_tracking_hash,
    created_by
  )
  values (
    v_customer_id,
    v_assigned_technician,
    order_data->>'brand',
    order_data->>'model',
    nullif(order_data->>'color', ''),
    nullif(order_data->>'storageCapacity', ''),
    nullif(order_data->>'platform', ''),
    nullif(order_data->>'lockType', ''),
    order_data->>'reportedIssue',
    coalesce(order_data->>'physicalCondition', ''),
    coalesce(
      array(
        select jsonb_array_elements_text(
          coalesce(order_data->'accessories', '[]'::jsonb)
        )
      ),
      '{}'
    ),
    nullif(order_data->>'internalNotes', ''),
    tracking_hash,
    v_actor
  )
  returning public.work_orders.id, public.work_orders.order_number
       into v_new_order_id, v_new_order_number;

  insert into public.work_order_events(
    work_order_id,
    actor_id,
    new_status,
    public_summary
  )
  values (
    v_new_order_id,
    v_actor,
    'received',
    'Aparelho recebido pela assistência.'
  );

  if secret_ciphertext is not null and secret_iv is not null then
    insert into public.device_access_secrets(
      work_order_id,
      ciphertext,
      iv,
      expires_at,
      created_by
    )
    values (
      v_new_order_id,
      secret_ciphertext,
      secret_iv,
      now() + interval '30 days',
      v_actor
    );
  end if;

  return query
  select v_new_order_id, v_new_order_number;
end;
$$;

revoke all on function public.create_work_order_atomic(jsonb,jsonb,text,text,text) from public, anon;
grant execute on function public.create_work_order_atomic(jsonb,jsonb,text,text,text) to authenticated;

commit;
