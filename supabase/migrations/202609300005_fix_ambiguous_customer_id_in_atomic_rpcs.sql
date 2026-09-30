begin;

-- Qualify customer updates in the sale RPC to avoid PL/pgSQL output-variable ambiguity.
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
    select customer_record.id, customer_record.name into customer_id, customer_label
      from public.customers customer_record where customer_record.id = (customer_data->>'id')::uuid;
    if customer_id is null then raise exception 'customer not found' using errcode = 'P0002'; end if;
    update public.customers as customer_record
      set cpf = nullif(customer_data->>'cpf','')
      where customer_record.id = customer_id
        and customer_record.cpf is null
        and nullif(customer_data->>'cpf','') is not null;
  else
    customer_label := customer_data->>'name';
    insert into public.customers(name, whatsapp, email, cpf)
      values (customer_data->>'name', customer_data->>'whatsapp', nullif(customer_data->>'email',''), nullif(customer_data->>'cpf',''))
      returning public.customers.id into customer_id;
  end if;
  select inventory_item.name, inventory_item.quantity into item_label, available
    from public.inventory_items inventory_item where inventory_item.id = item_id for update;
  if item_label is null then raise exception 'item not found' using errcode = 'P0002'; end if;
  if available < sale_quantity then raise exception 'insufficient stock' using errcode = '22023'; end if;
  sale_total := round(price * sale_quantity, 2);
  insert into public.sales(customer_id, inventory_item_id, product_name, quantity, unit_price,
    total_amount, payment_method, occurred_on, created_by)
  values (customer_id, item_id, item_label, sale_quantity, price, sale_total, payment, sale_date, actor)
  returning public.sales.id into sale_identifier;
  update public.inventory_items as inventory_item
    set quantity = inventory_item.quantity - sale_quantity, updated_at = now()
    where inventory_item.id = item_id;
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
