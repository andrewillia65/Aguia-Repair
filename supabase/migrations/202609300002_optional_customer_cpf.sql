begin;

create or replace function public.is_valid_customer_cpf(cpf_value text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  digit_sum integer;
  expected_digit integer;
  idx integer;
begin
  if cpf_value is null then return true; end if;
  if cpf_value !~ '^[0-9]{11}$' or cpf_value = repeat(substring(cpf_value, 1, 1), 11) then
    return false;
  end if;
  digit_sum := 0;
  for idx in 1..9 loop
    digit_sum := digit_sum + substring(cpf_value, idx, 1)::integer * (11 - idx);
  end loop;
  expected_digit := (digit_sum * 10) % 11;
  if expected_digit = 10 then expected_digit := 0; end if;
  if expected_digit <> substring(cpf_value, 10, 1)::integer then return false; end if;
  digit_sum := 0;
  for idx in 1..10 loop
    digit_sum := digit_sum + substring(cpf_value, idx, 1)::integer * (12 - idx);
  end loop;
  expected_digit := (digit_sum * 10) % 11;
  if expected_digit = 10 then expected_digit := 0; end if;
  return expected_digit = substring(cpf_value, 11, 1)::integer;
end;
$$;
revoke all on function public.is_valid_customer_cpf(text) from public, anon;
grant execute on function public.is_valid_customer_cpf(text) to authenticated, service_role;

alter table public.customers
  add column cpf text,
  add constraint customers_cpf_format_check
    check (cpf is null or cpf ~ '^[0-9]{11}$'),
  add constraint customers_cpf_valid_check
    check (public.is_valid_customer_cpf(cpf));

create unique index customers_cpf_unique_idx
  on public.customers(cpf)
  where cpf is not null;

create or replace function public.create_work_order_atomic(
  customer_data jsonb,
  order_data jsonb,
  tracking_hash text,
  secret_ciphertext text default null,
  secret_iv text default null
)
returns table (id uuid, order_number text)
language plpgsql security definer
set search_path = ''
as $$
declare customer_id uuid; new_order_id uuid; new_order_number text; assigned_technician uuid; actor uuid := auth.uid();
begin
  if actor is null or not public.staff_has_permission('work_orders.create') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select case when role = 'technician' then user_id else null end
    into assigned_technician from public.staff_profiles where user_id = actor and active = true;
  if nullif(customer_data->>'id','') is not null then
    select c.id into customer_id from public.customers c where c.id = (customer_data->>'id')::uuid;
    if customer_id is null then raise exception 'customer not found' using errcode = 'P0002'; end if;
    update public.customers
      set cpf = nullif(customer_data->>'cpf','')
      where id = customer_id and cpf is null and nullif(customer_data->>'cpf','') is not null;
  else
    insert into public.customers(name, whatsapp, email, cpf)
      values (customer_data->>'name', customer_data->>'whatsapp', nullif(customer_data->>'email',''), nullif(customer_data->>'cpf',''))
      returning public.customers.id into customer_id;
  end if;
  insert into public.work_orders(
    customer_id, assigned_technician_id, brand, model, color, storage_capacity, platform, lock_type,
    reported_issue, physical_condition, accessories, internal_notes, public_tracking_hash, created_by
  ) values (
    customer_id, assigned_technician, order_data->>'brand', order_data->>'model', nullif(order_data->>'color',''),
    nullif(order_data->>'storageCapacity',''), nullif(order_data->>'platform',''), nullif(order_data->>'lockType',''),
    order_data->>'reportedIssue', coalesce(order_data->>'physicalCondition',''),
    coalesce(array(select jsonb_array_elements_text(coalesce(order_data->'accessories','[]'::jsonb))), '{}'),
    nullif(order_data->>'internalNotes',''), tracking_hash, actor
  ) returning public.work_orders.id, public.work_orders.order_number into new_order_id, new_order_number;
  insert into public.work_order_events(work_order_id, actor_id, new_status, public_summary)
    values (new_order_id, actor, 'received', 'Aparelho recebido pela assistência.');
  if secret_ciphertext is not null and secret_iv is not null then
    insert into public.device_access_secrets(work_order_id, ciphertext, iv, expires_at, created_by)
      values (new_order_id, secret_ciphertext, secret_iv, now() + interval '30 days', actor);
  end if;
  return query select new_order_id, new_order_number;
end;
$$;
revoke all on function public.create_work_order_atomic(jsonb,jsonb,text,text,text) from public, anon;
grant execute on function public.create_work_order_atomic(jsonb,jsonb,text,text,text) to authenticated;

create or replace function public.record_product_sale_atomic(customer_data jsonb, sale_data jsonb)
returns table (sale_id uuid, total numeric, item_name text)
language plpgsql security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid(); customer_id uuid; item_id uuid; available integer; item_label text;
  sale_quantity integer; price numeric(12,2); sale_total numeric(12,2); sale_identifier uuid;
  payment text; sale_date date; customer_label text;
begin
  if actor is null or not public.staff_has_permission('sales.create') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if nullif(sale_data->>'inventoryItemId','') is null or nullif(sale_data->>'quantity','') is null
     or nullif(sale_data->>'unitPrice','') is null then
    raise exception 'invalid sale' using errcode = '22023';
  end if;
  item_id := (sale_data->>'inventoryItemId')::uuid;
  sale_quantity := (sale_data->>'quantity')::integer;
  price := (sale_data->>'unitPrice')::numeric(12,2);
  payment := coalesce(nullif(sale_data->>'paymentMethod',''), 'other');
  sale_date := coalesce(nullif(sale_data->>'occurredOn','')::date, current_date);
  if sale_quantity <= 0 or price < 0 or price > 9999999999.99 or payment not in ('pix','cash','card','transfer','other') then
    raise exception 'invalid sale' using errcode = '22023';
  end if;
  if nullif(customer_data->>'id','') is not null then
    select c.id, c.name into customer_id, customer_label
      from public.customers c where c.id = (customer_data->>'id')::uuid;
    if customer_id is null then raise exception 'customer not found' using errcode = 'P0002'; end if;
    update public.customers
      set cpf = nullif(customer_data->>'cpf','')
      where id = customer_id and cpf is null and nullif(customer_data->>'cpf','') is not null;
  else
    customer_label := customer_data->>'name';
    insert into public.customers(name, whatsapp, email, cpf)
      values (customer_data->>'name', customer_data->>'whatsapp', nullif(customer_data->>'email',''), nullif(customer_data->>'cpf',''))
      returning public.customers.id into customer_id;
  end if;
  select i.name, i.quantity into item_label, available
    from public.inventory_items i where i.id = item_id for update;
  if item_label is null then raise exception 'item not found' using errcode = 'P0002'; end if;
  if available < sale_quantity then raise exception 'insufficient stock' using errcode = '22023'; end if;
  sale_total := round(price * sale_quantity, 2);
  insert into public.sales(customer_id, inventory_item_id, product_name, quantity, unit_price,
    total_amount, payment_method, occurred_on, created_by)
  values (customer_id, item_id, item_label, sale_quantity, price, sale_total, payment, sale_date, actor)
  returning id into sale_identifier;
  update public.inventory_items set quantity = quantity - sale_quantity, updated_at = now() where id = item_id;
  insert into public.stock_movements(inventory_item_id, quantity_delta, reason, actor_id)
  values (item_id, -sale_quantity, 'Venda ' || sale_identifier::text, actor);
  insert into public.financial_entries(entry_type, amount, description, occurred_on, created_by)
  values ('income', sale_total, left('Venda: ' || item_label || ' x ' || sale_quantity::text || ' para ' || customer_label, 1000), sale_date, actor);
  return query select sale_identifier, sale_total, item_label;
end;
$$;
revoke all on function public.record_product_sale_atomic(jsonb,jsonb) from public, anon;
grant execute on function public.record_product_sale_atomic(jsonb,jsonb) to authenticated;

commit;
