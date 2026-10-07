import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';

const plaidHosts = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com'
};

const configured = () => Boolean(
  process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.BANK_TOKEN_ENCRYPTION_KEY || '')
);
const send = (res, status, body) => res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}).end(JSON.stringify(body));
const service = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth: {persistSession: false, autoRefreshToken: false}});

async function plaid(path, input) {
  const host = plaidHosts[process.env.PLAID_ENV || 'sandbox'];
  if (!host) throw Error('Invalid Plaid environment.');
  const response = await fetch(host + path, {
    method: 'POST', headers: {'content-type': 'application/json', 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET},
    body: JSON.stringify(input), signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error_message || 'Plaid request failed.');
  return result;
}

function encrypt(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.BANK_TOKEN_ENCRYPTION_KEY, 'hex'), iv);
  const content = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {token_ciphertext: content.toString('base64'), token_iv: iv.toString('base64'), token_tag: cipher.getAuthTag().toString('base64')};
}

function decrypt(connection) {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.BANK_TOKEN_ENCRYPTION_KEY, 'hex'), Buffer.from(connection.token_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(connection.token_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(connection.token_ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

async function readBody(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 65536) throw Error('Request too large.');
  }
  return JSON.parse(value || '{}');
}

export async function handlePlaid(req, res, pathname) {
  if (pathname === '/api/plaid/config' && req.method === 'GET') { send(res, 200, {enabled: configured()}); return true; }
  if (!pathname.startsWith('/api/plaid/')) return false;
  if (req.method !== 'POST') { send(res, 405, {error: 'Method not allowed.'}); return true; }
  if (!configured()) { send(res, 503, {error: 'Bank connections are not configured yet.'}); return true; }
  try {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!bearer) { send(res, 401, {error: 'Sign in first.'}); return true; }
    const db = service();
    const {data: {user}, error: authError} = await db.auth.getUser(bearer);
    if (authError || !user) { send(res, 401, {error: 'Session expired. Sign in again.'}); return true; }
    const body = await readBody(req);
    const accountId = body.account_id;
    const {data: account, error: accountError} = await db.from('accounts').select('id').eq('id', accountId).eq('user_id', user.id).maybeSingle();
    if (accountError || !account) { send(res, 404, {error: 'Account not found.'}); return true; }

    if (pathname === '/api/plaid/link-token') {
      const request = {
        user: {client_user_id: user.id}, client_name: 'RealtyBooks AI', products: ['transactions'],
        country_codes: ['US'], language: 'en'
      };
      if (process.env.PLAID_REDIRECT_URI) request.redirect_uri = process.env.PLAID_REDIRECT_URI;
      const result = await plaid('/link/token/create', request);
      send(res, 200, {link_token: result.link_token}); return true;
    }

    if (pathname === '/api/plaid/exchange') {
      if (typeof body.public_token !== 'string' || typeof body.plaid_account_id !== 'string') throw Error('Select a bank account to connect.');
      const {data: existing} = await db.from('plaid_connections').select('id').eq('account_id', account.id).maybeSingle();
      if (existing) throw Error('This account already has a bank connection.');
      const exchanged = await plaid('/item/public_token/exchange', {public_token: body.public_token});
      const accountList = await plaid('/accounts/get', {access_token: exchanged.access_token});
      const selected = accountList.accounts?.find(item => item.account_id === body.plaid_account_id);
      if (!selected || !['depository', 'credit'].includes(selected.type)) throw Error('Choose a checking, savings, or credit account.');
      const {error} = await db.from('plaid_connections').insert({
        user_id: user.id, account_id: account.id, item_id: exchanged.item_id,
        plaid_account_id: selected.account_id, institution_name: String(body.institution_name || '').slice(0, 120),
        ...encrypt(exchanged.access_token)
      });
      if (error) throw Error(error.message);
      send(res, 200, {connected: true}); return true;
    }

    const {data: connection, error: connectionError} = await db.from('plaid_connections').select('*').eq('account_id', account.id).eq('user_id', user.id).maybeSingle();
    if (connectionError) throw Error(connectionError.message);
    if (pathname === '/api/plaid/status') {
      send(res, 200, {connected: Boolean(connection), institution_name: connection?.institution_name || ''}); return true;
    }
    if (pathname !== '/api/plaid/sync') { send(res, 404, {error: 'Unknown endpoint.'}); return true; }
    if (!connection) throw Error('Connect this bank account first.');
    const token = decrypt(connection);
    let cursor = connection.sync_cursor || undefined;
    let added = [], modified = [], removed = [], result;
    do {
      result = await plaid('/transactions/sync', {access_token: token, ...(cursor ? {cursor} : {}), count: 500});
      added.push(...result.added); modified.push(...result.modified); removed.push(...result.removed);
      cursor = result.next_cursor;
    } while (result.has_more);
    const rows = [...added, ...modified].filter(item => item.account_id === connection.plaid_account_id && !item.pending && item.amount !== 0).map(item => ({
      user_id: user.id, account_id: account.id, source: 'plaid', external_id: item.transaction_id,
      posted_on: item.date, description: (item.merchant_name || item.name || 'Bank transaction').slice(0, 300),
      amount_cents: Math.round(-item.amount * 100)
    }));
    if (rows.length) {
      const {error} = await db.from('bank_transactions').upsert(rows, {onConflict: 'user_id,account_id,source,external_id'});
      if (error) throw Error(error.message);
    }
    // Plaid may replace a pending entry with a new posted ID. Pending entries are never imported.
    // Keep removed posted entries for manual review rather than silently erasing reconciled history.
    const {error: cursorError} = await db.from('plaid_connections').update({sync_cursor: cursor, updated_at: new Date().toISOString()}).eq('id', connection.id);
    if (cursorError) throw Error(cursorError.message);
    send(res, 200, {imported: rows.length, removed_for_review: removed.length}); return true;
  } catch (error) {
    send(res, 400, {error: error.message || 'Bank connection failed.'}); return true;
  }
}
