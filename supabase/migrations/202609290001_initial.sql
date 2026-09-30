-- Águia Repair production schema. No customer accounts or example records.
begin;

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create type public.staff_role as enum ('admin', 'technician', 'employee');
create type public.work_order_status as enum (
  'received', 'diagnosis', 'quote_sent', 'awaiting_approval', 'in_repair',
  'waiting_part', 'testing', 'ready', 'delivered', 'cancelled'
);
create type public.quote_status as enum ('draft', 'sent', 'approved', 'rejected', 'superseded');
create type public.warranty_status as enum ('active', 'expired', 'void');

create sequence public.work_order_number_seq start 1001;

create table public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 120),
  role public.staff_role not null default 'employee',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 160),
  whatsapp text not null check (length(whatsapp) between 8 and 24),
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only public-facing catalog information is stored in this table.
create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 160),
  description text not null default '' check (length(description) <= 2000),
  price numeric(12,2) check (price is null or price >= 0),
  image_url text check (image_url is null or image_url ~ '^https://'),
  is_published boolean not null default false,
  position integer not null default 0,
  created_by uuid references public.staff_profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  sku text unique,
  name text not null check (length(name) between 1 and 160),
  quantity integer not null default 0 check (quantity >= 0),
  minimum_quantity integer not null default 0 check (minimum_quantity >= 0),
  unit_cost numeric(12,2) not null default 0 check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default ('AR-' || lpad(nextval('public.work_order_number_seq')::text, 6, '0')),
  customer_id uuid not null references public.customers(id) on delete restrict,
  assigned_technician_id uuid references public.staff_profiles(user_id) on delete set null,
  brand text not null check (length(brand) between 1 and 80),
  model text not null check (length(model) between 1 and 120),
  color text,
  platform text check (platform is null or platform in ('android', 'iphone', 'other')),
  lock_type text check (lock_type is null or lock_type in ('none', 'pin', 'password', 'pattern', 'other')),
  reported_issue text not null check (length(reported_issue) between 1 and 4000),
  physical_condition text not null default '' check (length(physical_condition) <= 3000),
  accessories text[] not null default '{}',
  internal_notes text,
  public_tracking_hash text not null,
  status public.work_order_status not null default 'received',
  received_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index work_orders_status_idx on public.work_orders(status, updated_at desc);
create index work_orders_customer_idx on public.work_orders(customer_id, received_at desc);
create index work_orders_technician_idx on public.work_orders(assigned_technician_id, status);

create table public.work_order_events (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  actor_id uuid references public.staff_profiles(user_id) on delete set null,
  previous_status public.work_order_status,
  new_status public.work_order_status,
  public_summary text,
  internal_notes text,
  created_at timestamptz not null default now()
);
create index work_order_events_order_idx on public.work_order_events(work_order_id, created_at desc);

create table public.work_order_attachments (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  object_path text not null unique,
  original_name text not null check (length(original_name) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 10485760),
  uploaded_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  version integer not null check (version > 0),
  total numeric(12,2) not null check (total >= 0),
  summary text not null check (length(summary) between 1 and 2000),
  status public.quote_status not null default 'draft',
  approval_code_hash text,
  sent_at timestamptz,
  decided_at timestamptz,
  created_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (work_order_id, version)
);

create table public.warranties (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null unique references public.work_orders(id) on delete cascade,
  coverage_summary text not null check (length(coverage_summary) between 1 and 2000),
  starts_on date not null,
  expires_on date not null,
  status public.warranty_status not null default 'active',
  created_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  check (expires_on >= starts_on)
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  work_order_id uuid references public.work_orders(id) on delete set null,
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null check (length(reason) between 1 and 500),
  actor_id uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.financial_entries (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid references public.work_orders(id) on delete set null,
  entry_type text not null check (entry_type in ('income', 'expense')),
  amount numeric(12,2) not null check (amount >= 0),
  description text not null check (length(description) between 1 and 1000),
  occurred_on date not null default current_date,
  created_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.staff_profiles(user_id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Device access credentials are encrypted before they reach this table.
create table public.device_access_secrets (
  work_order_id uuid primary key references public.work_orders(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  expires_at timestamptz not null,
  created_by uuid not null references public.staff_profiles(user_id) on delete restrict,
  created_at timestamptz not null default now()
);
create table public.device_secret_access_logs (
  id bigint generated always as identity primary key,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  actor_id uuid not null references public.staff_profiles(user_id) on delete restrict,
  accessed_at timestamptz not null default now()
);

create table private.public_lookup_limits (
  key_hash text primary key,
  attempt_count integer not null,
  window_ends_at timestamptz not null
);
create index public_lookup_limits_expiration_idx on private.public_lookup_limits(window_ends_at);
revoke all on all tables in schema private from public, anon, authenticated;
grant all on all tables in schema private to service_role;

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
        'inventory.read', 'inventory.manage', 'warranties.manage'
      ]))
    )
  );
$$;
revoke all on function public.staff_has_permission(text) from public, anon;
grant execute on function public.staff_has_permission(text) to authenticated;

create or replace function public.consume_public_lookup(key_digest text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare allowed boolean;
begin
  delete from private.public_lookup_limits where window_ends_at < now() - interval '1 day';
  insert into private.public_lookup_limits(key_hash, attempt_count, window_ends_at)
  values (key_digest, 1, now() + interval '10 minutes')
  on conflict (key_hash) do update set
    attempt_count = case when private.public_lookup_limits.window_ends_at <= now() then 1 else private.public_lookup_limits.attempt_count + 1 end,
    window_ends_at = case when private.public_lookup_limits.window_ends_at <= now() then now() + interval '10 minutes' else private.public_lookup_limits.window_ends_at end;
  select attempt_count <= 8 into allowed from private.public_lookup_limits where key_hash = key_digest;
  return coalesce(allowed, false);
end;
$$;
revoke all on function public.consume_public_lookup(text) from public, anon, authenticated;
grant execute on function public.consume_public_lookup(text) to service_role;

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
  insert into public.customers(name, whatsapp, email)
    values (customer_data->>'name', customer_data->>'whatsapp', nullif(customer_data->>'email',''))
    returning public.customers.id into customer_id;
  insert into public.work_orders(
    customer_id, assigned_technician_id, brand, model, color, platform, lock_type, reported_issue,
    physical_condition, accessories, internal_notes, public_tracking_hash, created_by
  ) values (
    customer_id, assigned_technician, order_data->>'brand', order_data->>'model', nullif(order_data->>'color',''),
    nullif(order_data->>'platform',''), nullif(order_data->>'lockType',''),
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

create or replace function public.change_work_order_status(order_id uuid, next_status public.work_order_status, public_note text default null, internal_note text default null)
returns public.work_orders
language plpgsql security definer
set search_path = ''
as $$
declare current_order public.work_orders; old_status public.work_order_status; actor uuid := auth.uid(); allowed_transition boolean;
begin
  if actor is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into current_order from public.work_orders w where w.id = order_id for update;
  if not found then raise exception 'work order not found' using errcode = 'P0002'; end if;
  old_status := current_order.status;
  if current_order.assigned_technician_id = actor then
    if not public.staff_has_permission('work_orders.update_assigned') then raise exception 'not authorized' using errcode = '42501'; end if;
  elsif not public.staff_has_permission('work_orders.update') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  allowed_transition := case old_status
    when 'received' then next_status in ('diagnosis','cancelled')
    when 'diagnosis' then next_status in ('quote_sent','awaiting_approval','in_repair','waiting_part','cancelled')
    when 'quote_sent' then next_status in ('awaiting_approval','diagnosis','cancelled')
    when 'awaiting_approval' then next_status in ('in_repair','diagnosis','cancelled')
    when 'in_repair' then next_status in ('waiting_part','testing','cancelled')
    when 'waiting_part' then next_status in ('in_repair','cancelled')
    when 'testing' then next_status in ('in_repair','ready')
    when 'ready' then next_status = 'delivered'
    else false
  end;
  if not allowed_transition then raise exception 'invalid status transition' using errcode = '22023'; end if;
  update public.work_orders set status = next_status,
    delivered_at = case when next_status = 'delivered' then now() else delivered_at end,
    updated_at = now() where id = order_id returning * into current_order;
  insert into public.work_order_events(work_order_id, actor_id, previous_status, new_status, public_summary, internal_notes)
    values (order_id, actor, old_status, next_status, nullif(public_note,''), nullif(internal_note,''));
  insert into public.audit_logs(actor_id, action, entity_type, entity_id)
    values (actor, 'work_order.status_changed', 'work_order', order_id);
  return current_order;
end;
$$;
revoke all on function public.change_work_order_status(uuid,public.work_order_status,text,text) from public, anon;
grant execute on function public.change_work_order_status(uuid,public.work_order_status,text,text) to authenticated;

create or replace function public.send_work_order_quote(p_order_number text, p_total numeric, p_summary text)
returns table (quote_id uuid, order_number text, quote_version integer)
language plpgsql security definer
set search_path = ''
as $$
declare target_order public.work_orders; actor uuid := auth.uid(); next_version integer; new_quote_id uuid;
begin
  if actor is null or p_total is null or p_total < 0 or length(trim(coalesce(p_summary,''))) not between 1 and 2000 then
    raise exception 'invalid quote' using errcode = '22023';
  end if;
  select * into target_order from public.work_orders w
    where w.order_number = upper(trim(p_order_number)) for update;
  if not found then raise exception 'work order not found' using errcode = 'P0002'; end if;
  if target_order.assigned_technician_id = actor then
    if not public.staff_has_permission('work_orders.update_assigned') then raise exception 'not authorized' using errcode = '42501'; end if;
  elsif not public.staff_has_permission('work_orders.update') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if target_order.status not in ('diagnosis','quote_sent','awaiting_approval') then
    raise exception 'work order is not awaiting a quote' using errcode = '22023';
  end if;
  select coalesce(max(q.version), 0) + 1 into next_version from public.quotes q where q.work_order_id = target_order.id;
  update public.quotes set status = 'superseded'
    where work_order_id = target_order.id and status = 'sent';
  insert into public.quotes(work_order_id, version, total, summary, status, sent_at, created_by)
    values (target_order.id, next_version, p_total, trim(p_summary), 'sent', now(), actor)
    returning id into new_quote_id;
  if target_order.status = 'diagnosis' then
    insert into public.work_order_events(work_order_id, actor_id, previous_status, new_status, public_summary)
      values (target_order.id, actor, 'diagnosis', 'quote_sent', 'Orçamento enviado ao cliente.');
    insert into public.work_order_events(work_order_id, actor_id, previous_status, new_status, public_summary)
      values (target_order.id, actor, 'quote_sent', 'awaiting_approval', 'Aguardando aprovação do cliente.');
  else
    insert into public.work_order_events(work_order_id, actor_id, previous_status, new_status, public_summary)
      values (target_order.id, actor, target_order.status, 'awaiting_approval', 'Novo orçamento enviado para aprovação.');
  end if;
  update public.work_orders set status = 'awaiting_approval', updated_at = now() where id = target_order.id;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id)
    values (actor, 'quote.sent', 'work_order', target_order.id);
  return query select new_quote_id, target_order.order_number, next_version;
end;
$$;
revoke all on function public.send_work_order_quote(text,numeric,text) from public, anon;
grant execute on function public.send_work_order_quote(text,numeric,text) to authenticated;

-- Called only by the public Edge Function after it verifies the OS access code.
create or replace function public.decide_public_quote(p_work_order_id uuid, p_decision text)
returns table (order_number text, quote_status public.quote_status, work_order_status public.work_order_status)
language plpgsql security definer
set search_path = ''
as $$
declare target_order public.work_orders; target_quote public.quotes; next_order_status public.work_order_status;
begin
  if p_decision not in ('approved','rejected') then raise exception 'invalid decision' using errcode = '22023'; end if;
  select * into target_order from public.work_orders w where w.id = p_work_order_id for update;
  if not found or target_order.status <> 'awaiting_approval' then raise exception 'quote unavailable' using errcode = 'P0002'; end if;
  select * into target_quote from public.quotes q
    where q.work_order_id = target_order.id and q.status = 'sent'
    order by q.version desc limit 1 for update;
  if not found then raise exception 'quote unavailable' using errcode = 'P0002'; end if;
  next_order_status := case when p_decision = 'approved' then 'in_repair'::public.work_order_status else 'diagnosis'::public.work_order_status end;
  update public.quotes set status = p_decision::public.quote_status, decided_at = now() where id = target_quote.id;
  update public.work_orders set status = next_order_status, updated_at = now() where id = target_order.id;
  insert into public.work_order_events(work_order_id, previous_status, new_status, public_summary)
    values (
      target_order.id, target_order.status, next_order_status,
      case when p_decision = 'approved' then 'Orçamento aprovado pelo cliente.' else 'Orçamento recusado pelo cliente; a assistência entrará em contato.' end
    );
  insert into public.audit_logs(action, entity_type, entity_id)
    values ('quote.public_' || p_decision, 'work_order', target_order.id);
  return query select target_order.order_number, p_decision::public.quote_status, next_order_status;
end;
$$;
revoke all on function public.decide_public_quote(uuid,text) from public, anon, authenticated;
grant execute on function public.decide_public_quote(uuid,text) to service_role;

create or replace function public.staff_can_read_device_secret(order_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.work_orders w
    where w.id = order_id and (
      public.staff_has_permission('device_secrets.read')
      or (w.assigned_technician_id = auth.uid() and public.staff_has_permission('device_secrets.read_assigned'))
    )
  );
$$;
revoke all on function public.staff_can_read_device_secret(uuid) from public, anon;
grant execute on function public.staff_can_read_device_secret(uuid) to authenticated;

alter table public.staff_profiles enable row level security;
alter table public.customers enable row level security;
alter table public.catalog_items enable row level security;
alter table public.inventory_items enable row level security;
alter table public.work_orders enable row level security;
alter table public.work_order_events enable row level security;
alter table public.work_order_attachments enable row level security;
alter table public.quotes enable row level security;
alter table public.warranties enable row level security;
alter table public.stock_movements enable row level security;
alter table public.financial_entries enable row level security;
alter table public.audit_logs enable row level security;
alter table public.device_access_secrets enable row level security;
alter table public.device_secret_access_logs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select (id, name, description, price, image_url, is_published, position) on public.catalog_items to anon;
grant select on public.staff_profiles, public.customers, public.catalog_items, public.inventory_items,
  public.work_orders, public.work_order_events, public.work_order_attachments, public.quotes, public.warranties,
  public.stock_movements, public.financial_entries, public.audit_logs to authenticated;
grant insert, update, delete on public.customers, public.catalog_items, public.inventory_items,
  public.warranties to authenticated;
grant insert on public.stock_movements, public.financial_entries to authenticated;
grant insert on public.work_order_attachments to authenticated;
grant usage, select on all sequences in schema public to service_role;
grant all on all tables in schema public to service_role;

create policy "Public sees published products" on public.catalog_items for select to anon using (is_published);
create policy "Staff sees own profile or admins see team" on public.staff_profiles for select to authenticated
  using (user_id = auth.uid() or public.staff_has_permission('staff.manage'));
create policy "Admins manage staff" on public.staff_profiles for all to authenticated
  using (public.staff_has_permission('staff.manage')) with check (public.staff_has_permission('staff.manage'));

create policy "Employees manage customers" on public.customers for all to authenticated
  using (public.staff_has_permission('customers.manage')) with check (public.staff_has_permission('customers.manage'));
create policy "Staff read assigned customers" on public.customers for select to authenticated
  using (public.staff_has_permission('customers.read') or exists (
    select 1 from public.work_orders w where w.customer_id = customers.id
      and w.assigned_technician_id = auth.uid() and public.staff_has_permission('customers.read_assigned')
  ));

create policy "Staff see applicable orders" on public.work_orders for select to authenticated
  using (public.staff_has_permission('work_orders.read') or (
    assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.read_assigned')
  ));
create policy "Staff read applicable events" on public.work_order_events for select to authenticated
  using (exists (select 1 from public.work_orders w where w.id = work_order_id and (
    public.staff_has_permission('work_orders.read') or (w.assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.read_assigned'))
  )));
create policy "Staff read applicable attachments" on public.work_order_attachments for select to authenticated
  using (exists (select 1 from public.work_orders w where w.id = work_order_id and (
    public.staff_has_permission('work_orders.read') or (w.assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.read_assigned'))
  )));
create policy "Staff add applicable attachments" on public.work_order_attachments for insert to authenticated
  with check (uploaded_by = auth.uid() and exists (select 1 from public.work_orders w where w.id = work_order_id and (
    public.staff_has_permission('work_orders.update') or (w.assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.update_assigned'))
  )));

create policy "Staff manage applicable catalog" on public.catalog_items for all to authenticated
  using (public.staff_has_permission('catalog.manage')) with check (public.staff_has_permission('catalog.manage'));
create policy "Staff read inventory" on public.inventory_items for select to authenticated
  using (public.staff_has_permission('inventory.read') or public.staff_has_permission('inventory.manage'));
create policy "Staff manage inventory" on public.inventory_items for all to authenticated
  using (public.staff_has_permission('inventory.manage')) with check (public.staff_has_permission('inventory.manage'));
create policy "Staff read applicable quotes" on public.quotes for select to authenticated
  using (public.staff_has_permission('work_orders.read') or exists (select 1 from public.work_orders w where w.id=work_order_id and w.assigned_technician_id=auth.uid() and public.staff_has_permission('work_orders.read_assigned')));
create policy "Staff read warranties" on public.warranties for select to authenticated
  using (public.staff_has_permission('work_orders.read') or exists (
    select 1 from public.work_orders w where w.id = work_order_id
      and w.assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.read_assigned')
  ));
create policy "Employees manage warranties" on public.warranties for all to authenticated
  using (public.staff_has_permission('warranties.manage')) with check (public.staff_has_permission('warranties.manage'));
create policy "Staff read stock movements" on public.stock_movements for select to authenticated
  using (public.staff_has_permission('inventory.read') or public.staff_has_permission('inventory.manage'));
create policy "Authorized staff add stock movements" on public.stock_movements for insert to authenticated
  with check (actor_id=auth.uid() and public.staff_has_permission('inventory.manage'));
create policy "Admins manage finances" on public.financial_entries for all to authenticated
  using (public.staff_has_permission('finance.manage')) with check (public.staff_has_permission('finance.manage'));
create policy "Admins read audit logs" on public.audit_logs for select to authenticated
  using (public.staff_has_permission('audit.read'));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('work-order-photos', 'work-order-photos', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];
create policy "Staff read private work-order photos" on storage.objects for select to authenticated
  using (bucket_id = 'work-order-photos' and exists (
    select 1 from public.work_orders w where w.id::text = (storage.foldername(name))[1] and (
      public.staff_has_permission('work_orders.read') or (w.assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.read_assigned'))
    )
  ));
create policy "Staff upload private work-order photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'work-order-photos' and exists (
    select 1 from public.work_orders w where w.id::text = (storage.foldername(name))[1] and (
      public.staff_has_permission('work_orders.update') or (w.assigned_technician_id = auth.uid() and public.staff_has_permission('work_orders.update_assigned'))
    )
  ));
create policy "Authorized staff delete work-order photos" on storage.objects for delete to authenticated
  using (bucket_id = 'work-order-photos' and exists (
    select 1 from public.work_orders w where w.id::text = (storage.foldername(name))[1] and public.staff_has_permission('work_orders.update')
  ));

-- Device secret tables intentionally have no policies. Edge Functions alone use service_role.
commit;
