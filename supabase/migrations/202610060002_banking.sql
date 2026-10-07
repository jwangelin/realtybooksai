-- Imported bank activity stays separate from the bookkeeping ledger until matched.
create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  source text not null check (source in ('csv','pdf','plaid')),
  external_id text not null,
  posted_on date not null,
  description text not null check (char_length(description) between 1 and 300),
  amount_cents bigint not null check (amount_cents <> 0),
  created_at timestamptz not null default now(),
  unique (user_id, account_id, source, external_id)
);
create index bank_transactions_account_date_idx on public.bank_transactions(account_id, posted_on desc);
alter table public.bank_transactions enable row level security;
create policy "owners manage bank transactions" on public.bank_transactions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.bank_matches (
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (bank_transaction_id, transaction_id)
);
alter table public.bank_matches enable row level security;
create policy "owners manage bank matches" on public.bank_matches for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.reconciliations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  statement_start date not null,
  statement_end date not null,
  beginning_balance_cents bigint not null,
  ending_balance_cents bigint not null,
  created_at timestamptz not null default now(),
  check (statement_start <= statement_end),
  unique (account_id, statement_start, statement_end)
);
alter table public.reconciliations enable row level security;
create policy "owners manage reconciliations" on public.reconciliations for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- RLS checks the row owner. These triggers also prevent cross-account links.
create or replace function public.enforce_bank_account_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.accounts a where a.id = new.account_id and a.user_id = new.user_id)
  then raise exception 'Account must belong to the same user'; end if;
  return new;
end; $$;
create trigger bank_transaction_owner before insert or update on public.bank_transactions
  for each row execute function public.enforce_bank_account_owner();
create trigger reconciliation_owner before insert or update on public.reconciliations
  for each row execute function public.enforce_bank_account_owner();

create or replace function public.enforce_bank_match_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.bank_transactions b join public.transactions t
      on t.id = new.transaction_id and t.user_id = b.user_id and t.account_id = b.account_id
    where b.id = new.bank_transaction_id and b.user_id = new.user_id
  ) then raise exception 'Bank and book entries must belong to the same account and user'; end if;
  return new;
end; $$;
create trigger bank_match_owner before insert or update on public.bank_matches
  for each row execute function public.enforce_bank_match_owner();
