-- RealtyBooks AI: each signed-in person can access only their own records.
create extension if not exists pgcrypto;

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  kind text not null check (kind in ('checking','savings','credit_card','cash')),
  created_at timestamptz not null default now()
);
create index accounts_user_id_idx on public.accounts(user_id);
alter table public.accounts enable row level security;
create policy "owners manage accounts" on public.accounts for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  occurred_on date not null,
  kind text not null check (kind in ('income','expense')),
  category text not null check (char_length(category) between 1 and 100),
  description text not null check (char_length(description) between 1 and 300),
  amount_cents bigint not null check (amount_cents > 0),
  contact text not null default '',
  property_address text not null default '',
  sale_price_cents bigint check (sale_price_cents is null or sale_price_cents >= 0),
  loan_amount_cents bigint check (loan_amount_cents is null or loan_amount_cents >= 0),
  notes text not null default '',
  attachment_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transactions_user_date_idx on public.transactions(user_id,occurred_on desc);
alter table public.transactions enable row level security;
create policy "owners manage transactions" on public.transactions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.enforce_transaction_account_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.account_id is not null and not exists (
    select 1 from public.accounts a where a.id = new.account_id and a.user_id = new.user_id
  ) then raise exception 'Account must belong to the same user'; end if;
  return new;
end; $$;
create trigger transaction_account_owner before insert or update on public.transactions
  for each row execute function public.enforce_transaction_account_owner();

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;
create trigger transactions_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('attachments','attachments',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "owners upload attachments" on storage.objects for insert to authenticated
  with check (bucket_id='attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners read attachments" on storage.objects for select to authenticated
  using (bucket_id='attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "owners delete attachments" on storage.objects for delete to authenticated
  using (bucket_id='attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
