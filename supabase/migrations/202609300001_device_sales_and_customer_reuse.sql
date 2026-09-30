begin;

alter table public.work_orders
  add column storage_capacity text check (storage_capacity is null or length(storage_capacity) <= 40);

alter table public.inventory_items
  add column sale_price numeric(12,2) check (sale_price is null or sale_price >= 0);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  product_name text not null check (length(product_name) between 1 and 160),
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  total_amount numeric(12,2) not null check (total_amount >= 0),
  payment_method text not null check (payment_method in ('pix','cash','card','transfer','other')),
  occurred_on date not null default current_date,
  created_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now()
);
create index sales_occurred_on_idx on public.sales(occurred_on desc, created_at desc);

create or replace function public.staff_has_permission(permission_key text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_profiles p
    where p.user_id = auth.uid() and p.active = true and (
      p.role = 'admin'
      or (p.role = 'technician' and permission_key = any(array[
        'work_orders.create', 'work_orders.read_assigned', 'work_orders.update_assigned',
        'customers.read_assigned', 'device_secrets.read_assigned'
      ]))
      or (p.role = 'employee' and permission_key = any(array[
        'work_orders.read', 'work_orders.create', 'work_orders.update',
        'customers.read', 'customers.manage', 'catalog.manage',
        'inventory.read', 'inventory.manage', 'warranties.manage',
        'sales.read', 'sales.create'
      ]))
    )
  );
$$;

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
  else
    insert into public.customers(name, whatsapp, email)
      values (customer_data->>'name', customer_data->>'whatsapp', nullif(customer_data->>'email',''))
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
  else
    customer_label := customer_data->>'name';
    insert into public.customers(name, whatsapp, email)
      values (customer_data->>'name', customer_data->>'whatsapp', nullif(customer_data->>'email',''))
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

alter table public.sales enable row level security;
revoke all on public.sales from public, anon, authenticated;
grant select on public.sales to authenticated;
grant all on public.sales to service_role;
create policy "Staff read product sales" on public.sales for select to authenticated
  using (public.staff_has_permission('sales.read'));

commit;
