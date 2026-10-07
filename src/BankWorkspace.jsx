import React, {useEffect, useMemo, useState} from 'react';
import {FileUp, Link2, RefreshCw} from 'lucide-react';
import {supabase} from './lib/supabase';
import {rowFingerprint, rowsFromCsv, rowsFromPdf} from './lib/bankImport';

const money = cents => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format((cents || 0) / 100);
const signed = entry => (entry.kind === 'income' ? 1 : -1) * entry.amount_cents;
const today = () => new Date().toISOString().slice(0, 10);
const startOfMonth = () => `${today().slice(0, 7)}-01`;

export default function BankWorkspace({account, ledger, userId, onNotice}) {
  const [bank, setBank] = useState([]);
  const [matches, setMatches] = useState([]);
  const [history, setHistory] = useState([]);
  const [preview, setPreview] = useState([]);
  const [source, setSource] = useState('csv');
  const [selectedBank, setSelectedBank] = useState(null);
  const [selectedLedger, setSelectedLedger] = useState([]);
  const [range, setRange] = useState({start: startOfMonth(), end: today(), beginning: '', ending: ''});
  const [busy, setBusy] = useState(false);
  const [plaidEnabled, setPlaidEnabled] = useState(false);
  const [plaidStatus, setPlaidStatus] = useState(null);
  const [pendingToken, setPendingToken] = useState('');
  const [plaidAccounts, setPlaidAccounts] = useState([]);
  const [plaidAccountId, setPlaidAccountId] = useState('');
  const [institutionName, setInstitutionName] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([
      supabase.from('bank_transactions').select('*').eq('account_id', account.id).order('posted_on', {ascending: false}),
      supabase.from('bank_matches').select('bank_transaction_id,transaction_id'),
      supabase.from('reconciliations').select('*').eq('account_id', account.id).order('statement_end', {ascending: false})
    ]).then(([transactions, links, reconciliations]) => {
      if (!active) return;
      const error = transactions.error || links.error || reconciliations.error;
      if (error) onNotice(error.message);
      else { setBank(transactions.data || []); setMatches(links.data || []); setHistory(reconciliations.data || []); }
    });
    return () => { active = false; };
  }, [account.id, version]);

  useEffect(() => {
    let active = true;
    fetch('/api/plaid/config').then(response => response.json()).then(config => {
      if (!active) return;
      setPlaidEnabled(config.enabled);
      if (config.enabled) plaidRequest('/api/plaid/status', {account_id: account.id}).then(status => active && setPlaidStatus(status)).catch(error => onNotice(error.message));
    }).catch(() => {});
    return () => { active = false; };
  }, [account.id]);

  async function plaidRequest(path, body) {
    const {data: {session}} = await supabase.auth.getSession();
    if (!session) throw Error('Sign in again to connect a bank.');
    const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${session.access_token}`}, body: JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Bank request failed.');
    return result;
  }

  async function loadPlaid() {
    if (window.Plaid) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      script.onload = resolve;
      script.onerror = () => reject(Error('Could not load Plaid Link.'));
      document.head.appendChild(script);
    });
  }

  async function launchPlaid(linkToken, redirect = false) {
    await loadPlaid();
    const handler = window.Plaid.create({
      token: linkToken,
      ...(redirect ? {receivedRedirectUri: window.location.href} : {}),
      onSuccess: (publicToken, metadata) => {
        sessionStorage.removeItem('realtybooks_plaid_link_token');
        sessionStorage.removeItem('realtybooks_plaid_account');
        if (window.location.search.includes('oauth_state_id')) window.history.replaceState({}, '', window.location.pathname);
        setPendingToken(publicToken);
        setPlaidAccounts(metadata.accounts || []);
        setPlaidAccountId(metadata.accounts?.[0]?.id || '');
        setInstitutionName(metadata.institution?.name || '');
      },
      onExit: (error) => { if (error) onNotice(error.display_message || 'Bank connection was cancelled.'); }
    });
    handler.open();
  }

  useEffect(() => {
    if (!plaidEnabled || !window.location.search.includes('oauth_state_id')) return;
    if (sessionStorage.getItem('realtybooks_plaid_account') !== account.id) return;
    const token = sessionStorage.getItem('realtybooks_plaid_link_token');
    if (token) launchPlaid(token, true).catch(error => onNotice(error.message));
  }, [plaidEnabled, account.id]);

  async function connectPlaid() {
    setBusy(true);
    try {
      const {link_token} = await plaidRequest('/api/plaid/link-token', {account_id: account.id});
      sessionStorage.setItem('realtybooks_plaid_link_token', link_token);
      sessionStorage.setItem('realtybooks_plaid_account', account.id);
      await launchPlaid(link_token);
    } catch (error) { onNotice(error.message); }
    finally { setBusy(false); }
  }

  async function finishPlaid() {
    if (!pendingToken || !plaidAccountId) return;
    setBusy(true);
    try {
      await plaidRequest('/api/plaid/exchange', {account_id: account.id, public_token: pendingToken, plaid_account_id: plaidAccountId, institution_name: institutionName});
      setPendingToken(''); setPlaidAccounts([]);
      setPlaidStatus({connected: true, institution_name: institutionName});
      await syncPlaid();
    } catch (error) { onNotice(error.message); }
    finally { setBusy(false); }
  }

  async function syncPlaid() {
    setBusy(true);
    try {
      const result = await plaidRequest('/api/plaid/sync', {account_id: account.id});
      setVersion(value => value + 1);
      onNotice(`Bank sync complete. ${result.imported} transaction rows received.`);
    } catch (error) { onNotice(error.message); }
    finally { setBusy(false); }
  }

  const bookRows = useMemo(() => ledger.filter(row => row.account_id === account.id), [ledger, account.id]);
  const usedIds = new Set(matches.map(match => match.transaction_id));
  const chosen = bank.find(row => row.id === selectedBank);
  const existing = matches.filter(match => match.bank_transaction_id === selectedBank)
    .map(match => bookRows.find(row => row.id === match.transaction_id)).filter(Boolean);
  const existingTotal = existing.reduce((sum, row) => sum + signed(row), 0);
  const pickedTotal = selectedLedger.reduce((sum, id) => sum + signed(bookRows.find(row => row.id === id)), 0);
  const eligible = bookRows.filter(row => !usedIds.has(row.id) && (!chosen || Math.abs(new Date(row.occurred_on) - new Date(chosen.posted_on)) <= 45 * 86400000));
  const periodBank = bank.filter(row => row.posted_on >= range.start && row.posted_on <= range.end);
  const unmatched = periodBank.filter(row => matches.filter(link => link.bank_transaction_id === row.id)
    .reduce((sum, link) => sum + signed(bookRows.find(entry => entry.id === link.transaction_id) || {kind: 'income', amount_cents: 0}), 0) !== row.amount_cents);
  const clearedTotal = periodBank.reduce((sum, row) => sum + matches.filter(link => link.bank_transaction_id === row.id)
    .reduce((part, link) => part + signed(bookRows.find(entry => entry.id === link.transaction_id) || {kind: 'income', amount_cents: 0}), 0), 0);
  const outstanding = bookRows.filter(row => row.occurred_on >= range.start && row.occurred_on <= range.end && !usedIds.has(row.id));
  const beginning = Math.round(Number(range.beginning) * 100);
  const ending = Math.round(Number(range.ending) * 100);
  const difference = beginning + clearedTotal - ending;
  const ready = range.start <= range.end && range.beginning !== '' && range.ending !== '' && Number.isSafeInteger(beginning) && Number.isSafeInteger(ending) && unmatched.length === 0 && difference === 0;

  async function openFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const kind = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'csv';
      const parsed = kind === 'pdf' ? await rowsFromPdf(file) : rowsFromCsv(await file.text());
      if (!parsed.length) throw Error('No usable transactions were found in this statement.');
      setSource(kind);
      setPreview(parsed);
      onNotice(`Review ${parsed.length} bank rows before importing.`);
    } catch (error) { onNotice(error.message); }
    finally { setBusy(false); event.target.value = ''; }
  }

  async function importRows() {
    setBusy(true);
    try {
      const invalid = preview.find(row => !row.posted_on || !row.description.trim() || !Number.isSafeInteger(row.amount_cents) || row.amount_cents === 0);
      if (invalid) throw Error('Correct every date, description, and amount before importing.');
      const payload = await Promise.all(preview.map(async row => ({
        user_id: userId, account_id: account.id, source,
        external_id: await rowFingerprint(row), posted_on: row.posted_on,
        description: row.description.trim(), amount_cents: row.amount_cents
      })));
      const {error} = await supabase.from('bank_transactions').upsert(payload, {onConflict: 'user_id,account_id,source,external_id', ignoreDuplicates: true});
      if (error) throw error;
      setPreview([]); setVersion(value => value + 1); onNotice('Statement rows imported. Existing duplicates were skipped.');
    } catch (error) { onNotice(error.message); }
    finally { setBusy(false); }
  }

  async function matchEntries() {
    if (!chosen || !selectedLedger.length || existingTotal + pickedTotal !== chosen.amount_cents) return;
    setBusy(true);
    const {error} = await supabase.from('bank_matches').insert(selectedLedger.map(transaction_id => ({bank_transaction_id: chosen.id, transaction_id, user_id: userId})));
    setBusy(false);
    if (error) onNotice(error.message);
    else { setSelectedLedger([]); setSelectedBank(null); setVersion(value => value + 1); onNotice('Bank activity matched to your books.'); }
  }

  async function removeMatches() {
    if (!chosen) return;
    setBusy(true);
    const {error} = await supabase.from('bank_matches').delete().eq('bank_transaction_id', chosen.id);
    setBusy(false);
    if (error) onNotice(error.message);
    else { setSelectedLedger([]); setVersion(value => value + 1); onNotice('Match cleared.'); }
  }

  async function reconcile() {
    if (!ready) return;
    setBusy(true);
    const {error} = await supabase.from('reconciliations').insert({
      user_id: userId, account_id: account.id, statement_start: range.start, statement_end: range.end,
      beginning_balance_cents: beginning, ending_balance_cents: ending
    });
    setBusy(false);
    if (error) onNotice(error.message);
    else { setVersion(value => value + 1); onNotice('Account reconciled for this statement period.'); }
  }

  return <div className="bank-workspace">
    <section className="panel bank-section">
      <div className="panel-head"><div><h2>Bank statement for {account.name}</h2><p>Import activity, then match each bank line with the entries already in your books.</p></div></div>
      <div className="plaid-controls"><button className="button primary" disabled={!plaidEnabled || busy || plaidStatus?.connected} onClick={connectPlaid}>Connect with Plaid</button>{plaidStatus?.connected && <><span>Connected: {plaidStatus.institution_name || 'Bank'}</span><button className="button subtle" disabled={busy} onClick={syncPlaid}>Sync bank activity</button></>}{!plaidEnabled && <span>Plaid connection is being configured. Statement import is available now.</span>}</div>
      {pendingToken && <div className="plaid-select"><label>Bank account to connect<select value={plaidAccountId} onChange={event => setPlaidAccountId(event.target.value)}>{plaidAccounts.map(item => <option key={item.id} value={item.id}>{item.name} {item.mask ? `••${item.mask}` : ''}</option>)}</select></label><button className="button primary" disabled={busy || !plaidAccountId} onClick={finishPlaid}>Use this account</button></div>}
      <label className="button subtle bank-file"><FileUp size={17}/> Import statement CSV or PDF<input type="file" accept=".csv,.pdf,text/csv,application/pdf" onChange={openFile} disabled={busy}/></label>
      <p className="muted">PDF imports work for text-based statements. Review every extracted amount and its sign before importing; scanned PDFs need a CSV export.</p>
      {preview.length > 0 && <div className="bank-preview"><h3>Review imported rows</h3><div className="bank-table-scroll"><table><thead><tr><th>Date</th><th>Description</th><th>Amount (deposits +, withdrawals −)</th><th/></tr></thead><tbody>{preview.map((row, index) => <tr key={index}><td><input type="date" value={row.posted_on || ''} onChange={event => setPreview(current => current.map((entry, i) => i === index ? {...entry, posted_on: event.target.value} : entry))}/></td><td><input value={row.description} onChange={event => setPreview(current => current.map((entry, i) => i === index ? {...entry, description: event.target.value} : entry))}/></td><td><input type="number" step="0.01" value={row.amount_cents / 100} onChange={event => setPreview(current => current.map((entry, i) => i === index ? {...entry, amount_cents: Math.round(Number(event.target.value) * 100)} : entry))}/></td><td><button className="link-button" onClick={() => setPreview(current => current.filter((_, i) => i !== index))}>Remove</button></td></tr>)}</tbody></table></div><div className="bank-actions"><button className="button subtle" onClick={() => setPreview([])}>Cancel</button><button className="button primary" disabled={busy} onClick={importRows}>Import {preview.length} rows</button></div></div>}
      <div className="bank-table-scroll"><table><thead><tr><th>Bank date</th><th>Bank description</th><th>Amount</th><th>Match</th></tr></thead><tbody>{bank.map(row => { const linked = matches.filter(match => match.bank_transaction_id === row.id).map(match => bookRows.find(entry => entry.id === match.transaction_id)).filter(Boolean); const matched = linked.reduce((sum, entry) => sum + signed(entry), 0); return <tr key={row.id}><td>{row.posted_on}</td><td>{row.description}</td><td className="numeric">{money(row.amount_cents)}</td><td><button className="link-button" onClick={() => { setSelectedBank(row.id); setSelectedLedger([]); }}>{matched === row.amount_cents ? `Matched (${linked.length})` : <><Link2 size={14}/> Match entries</>}</button></td></tr>; })}</tbody></table>{!bank.length && <p className="muted">Import a bank statement to begin matching.</p>}</div>
    </section>

    {chosen && <section className="panel bank-section"><h2>Match {money(chosen.amount_cents)} · {chosen.description}</h2><p>Choose one or more book entries. Their signed total must equal this bank amount. A net commission deposit can match its gross income, broker split, and broker fees together.</p><div className="match-amount"><span>Selected: <strong>{money(existingTotal + pickedTotal)}</strong></span><span>Remaining: <strong>{money(chosen.amount_cents - existingTotal - pickedTotal)}</strong></span></div>{existing.map(entry => <p className="matched-entry" key={entry.id}>✓ {entry.occurred_on} · {entry.description} · {money(signed(entry))}</p>)}<div className="match-options">{eligible.map(entry => <label key={entry.id}><input type="checkbox" checked={selectedLedger.includes(entry.id)} onChange={event => setSelectedLedger(current => event.target.checked ? [...current, entry.id] : current.filter(id => id !== entry.id))}/><span>{entry.occurred_on} · {entry.description}</span><strong>{money(signed(entry))}</strong></label>)}{!eligible.length && <p className="muted">No unmatched book entries within 45 days. Record the missing income or expense first, then return here.</p>}</div><div className="bank-actions"><button className="button subtle" onClick={() => setSelectedBank(null)}>Close</button>{existing.length > 0 && <button className="button subtle" disabled={busy} onClick={removeMatches}>Clear match</button>}<button className="button primary" disabled={busy || !selectedLedger.length || existingTotal + pickedTotal !== chosen.amount_cents} onClick={matchEntries}>Confirm match</button></div></section>}

    <section className="panel bank-section"><div className="panel-head"><div><h2>Month-end reconciliation</h2><p>Enter the beginning and ending balances shown on your bank statement.</p></div><RefreshCw size={18}/></div><div className="reconcile-grid"><label>Statement start<input type="date" value={range.start} onChange={event => setRange(value => ({...value, start: event.target.value}))}/></label><label>Statement end<input type="date" value={range.end} onChange={event => setRange(value => ({...value, end: event.target.value}))}/></label><label>Beginning balance<input type="number" step="0.01" value={range.beginning} onChange={event => setRange(value => ({...value, beginning: event.target.value}))} placeholder="0.00"/></label><label>Ending balance<input type="number" step="0.01" value={range.ending} onChange={event => setRange(value => ({...value, ending: event.target.value}))} placeholder="0.00"/></label></div><div className="reconcile-summary"><div><span>Cleared book activity</span><strong>{money(clearedTotal)}</strong></div><div><span>Calculated ending balance</span><strong>{range.beginning === '' ? '—' : money(beginning + clearedTotal)}</strong></div><div><span>Difference from statement</span><strong>{range.ending === '' || range.beginning === '' ? '—' : money(difference)}</strong></div><div><span>Unmatched bank rows</span><strong>{unmatched.length}</strong></div><div><span>Book entries not cleared by bank</span><strong>{outstanding.length}</strong></div></div><p className="muted">Outstanding book entries are shown for review. They do not affect the statement’s cleared balance until matched.</p><button className="button primary" disabled={!ready || busy || history.some(item => item.statement_start === range.start && item.statement_end === range.end)} onClick={reconcile}>Finish reconciliation</button>{history.length > 0 && <div className="reconcile-history"><h3>Completed statements</h3>{history.map(item => <p key={item.id}>{item.statement_start} to {item.statement_end} · Ending balance {money(item.ending_balance_cents)}</p>)}</div>}</section>
  </div>;
}
