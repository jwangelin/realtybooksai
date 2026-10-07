-- Only the Railway server (service role) may read Plaid access tokens.
create table public.plaid_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null unique references public.accounts(id) on delete cascade,
  item_id text not null,
  plaid_account_id text not null,
  institution_name text not null default '',
  token_ciphertext text not null,
  token_iv text not null,
  token_tag text not null,
  sync_cursor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plaid_connections_user_idx on public.plaid_connections(user_id);
alter table public.plaid_connections enable row level security;
-- No authenticated policy: the server validates the user's JWT and account owner.
