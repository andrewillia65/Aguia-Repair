begin;

create sequence public.warranty_number_seq start 1001;

alter table public.warranties
  alter column work_order_id drop not null,
  add column warranty_number text not null default ('GAR-' || lpad(nextval('public.warranty_number_seq')::text, 6, '0')),
  add column source_type text not null default 'work_order'
    check (source_type in ('work_order', 'sale', 'quick_service')),
  add column sale_id uuid references public.sales(id) on delete restrict,
  add column customer_id uuid references public.customers(id) on delete restrict,
  add column item_description text,
  add column public_code_hash text,
  add constraint warranties_source_data_check check (
    (source_type = 'work_order' and work_order_id is not null and sale_id is null and customer_id is null and item_description is null)
    or (source_type = 'sale' and work_order_id is null and sale_id is not null and customer_id is not null and item_description is not null and public_code_hash is not null)
    or (source_type = 'quick_service' and work_order_id is null and sale_id is null and customer_id is not null and item_description is not null and public_code_hash is not null)
  ),
  add constraint warranties_number_format_check check (warranty_number ~ '^GAR-[0-9]{6,10}$');

create unique index warranties_warranty_number_idx on public.warranties(warranty_number);
create unique index warranties_sale_id_unique_idx on public.warranties(sale_id) where source_type = 'sale';

create or replace function public.create_standalone_warranty(
  p_source_type text,
  p_customer_id uuid,
  p_customer_name text,
  p_customer_whatsapp text,
  p_sale_id uuid,
  p_item_description text,
  p_coverage_summary text,
  p_starts_on date,
  p_expires_on date,
  p_public_code_hash text
)
returns table (warranty_id uuid, warranty_number text)
language plpgsql security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_customer_id uuid;
  target_item_description text;
  sale_quantity integer;
  new_warranty_id uuid;
  new_warranty_number text;
begin
  if actor is null or not public.staff_has_permission('warranties.manage') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_source_type is null or p_source_type not in ('sale', 'quick_service')
     or p_starts_on is null or p_expires_on is null or p_expires_on < p_starts_on
     or length(trim(coalesce(p_coverage_summary, ''))) not between 1 and 2000
     or p_public_code_hash is null or p_public_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid warranty data' using errcode = '22023';
  end if;

  if p_source_type = 'sale' then
    if p_sale_id is null then raise exception 'sale required' using errcode = '22023'; end if;
    select s.customer_id, s.product_name, s.quantity
      into target_customer_id, target_item_description, sale_quantity
      from public.sales s where s.id = p_sale_id;
    if not found then raise exception 'sale not found' using errcode = 'P0002'; end if;
    if p_customer_id is not null and p_customer_id <> target_customer_id then
      raise exception 'sale customer mismatch' using errcode = '22023';
    end if;
    if sale_quantity > 1 then
      target_item_description := target_item_description || ' · Quantidade: ' || sale_quantity::text;
    end if;
  else
    if p_sale_id is not null
       or length(trim(coalesce(p_item_description, ''))) not between 1 and 300 then
      raise exception 'service data required' using errcode = '22023';
    end if;
    if p_customer_id is null then
      if length(trim(coalesce(p_customer_name, ''))) not between 2 and 160
         or length(trim(coalesce(p_customer_whatsapp, ''))) not between 8 and 24 then
        raise exception 'customer data required' using errcode = '22023';
      end if;
      insert into public.customers(name, whatsapp)
        values (trim(p_customer_name), trim(p_customer_whatsapp))
        returning customers.id into target_customer_id;
    else
      if not exists (select 1 from public.customers c where c.id = p_customer_id) then
        raise exception 'customer not found' using errcode = 'P0002';
      end if;
      target_customer_id := p_customer_id;
    end if;
    target_item_description := trim(p_item_description);
  end if;

  insert into public.warranties (
    source_type, sale_id, customer_id, item_description, public_code_hash,
    coverage_summary, starts_on, expires_on, status, created_by
  ) values (
    p_source_type, p_sale_id, target_customer_id, target_item_description, p_public_code_hash,
    trim(p_coverage_summary), p_starts_on, p_expires_on, 'active', actor
  ) returning id, warranties.warranty_number into new_warranty_id, new_warranty_number;

  return query select new_warranty_id, new_warranty_number;
end;
$$;

revoke all on function public.create_standalone_warranty(text,uuid,text,text,uuid,text,text,date,date,text) from public, anon;
grant execute on function public.create_standalone_warranty(text,uuid,text,text,uuid,text,text,date,date,text) to authenticated;

drop policy if exists "Staff read warranties" on public.warranties;
create policy "Staff read warranties" on public.warranties for select to authenticated
  using (public.staff_has_permission('work_orders.read') or public.staff_has_permission('warranties.manage') or exists (
    select 1 from public.work_orders w where w.id = work_order_id
      and w.assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.read_assigned')
  ));

grant usage, select on sequence public.warranty_number_seq to authenticated, service_role;

commit;
