import React, {useMemo, useState} from 'react';
import {X} from 'lucide-react';
import {supabase} from './lib/supabase';

const dollars = cents => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
const cents = value => Math.round(Number(value) * 100);

export default function CommissionForm({accounts, userId, onClose, onSaved, onNotice}) {
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    property: '', gross: '', split: '', fees: '', account: '', notes: ''
  });
  const [busy, setBusy] = useState(false);
  const update = (field, value) => setForm(previous => ({...previous, [field]: value}));
  const amounts = useMemo(() => ({
    gross: cents(form.gross), split: cents(form.split || 0), fees: cents(form.fees || 0)
  }), [form.gross, form.split, form.fees]);
  const net = amounts.gross - amounts.split - amounts.fees;

  async function save(event) {
    event.preventDefault();
    if (![amounts.gross, amounts.split, amounts.fees].every(Number.isSafeInteger) || amounts.gross <= 0 || amounts.split < 0 || amounts.fees < 0) {
      onNotice('Enter valid commission amounts.');
      return;
    }
    if (net < 0) {
      onNotice('Broker split and fees cannot exceed the total commission.');
      return;
    }
    setBusy(true);
    const shared = {
      user_id: userId, account_id: form.account || null, occurred_on: form.date,
      property_address: form.property.trim(), notes: form.notes.trim()
    };
    const label = form.property.trim() || 'Commission';
    const entries = [
      {...shared, kind: 'income', category: 'Commission income', description: `Gross commission · ${label}`, amount_cents: amounts.gross},
      ...(amounts.split ? [{...shared, kind: 'expense', category: 'Brokerage splits', description: `Broker split · ${label}`, amount_cents: amounts.split}] : []),
      ...(amounts.fees ? [{...shared, kind: 'expense', category: 'Broker fees', description: `Broker fees · ${label}`, amount_cents: amounts.fees}] : [])
    ];
    const {error} = await supabase.from('transactions').insert(entries);
    setBusy(false);
    if (error) onNotice(error.message);
    else {
      onSaved();
      onClose();
      onNotice(`Commission saved. Net deposit: ${dollars(net)}.`);
    }
  }

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-label="Record commission">
      <header><div><small>REALTYBOOKS</small><h2>Record a commission</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={20}/></button></header>
      <form onSubmit={save}>
        <div className="form-grid"><label>Date<input type="date" required value={form.date} onChange={event => update('date', event.target.value)}/></label><label>Deposit account<select value={form.account} onChange={event => update('account', event.target.value)}><option value="">Unassigned</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label></div>
        <label>Property or deal<input value={form.property} onChange={event => update('property', event.target.value)} placeholder="123 Main Street" maxLength="200"/></label>
        <label>Total commission<input type="number" min="0.01" step="0.01" required value={form.gross} onChange={event => update('gross', event.target.value)} placeholder="0.00"/></label>
        <div className="form-grid"><label>Broker split<input type="number" min="0" step="0.01" value={form.split} onChange={event => update('split', event.target.value)} placeholder="0.00"/></label><label>Broker fees<input type="number" min="0" step="0.01" value={form.fees} onChange={event => update('fees', event.target.value)} placeholder="0.00"/></label></div>
        <div className="commission-summary" aria-live="polite"><div><span>Total commission</span><strong>{dollars(Number.isFinite(amounts.gross) ? amounts.gross : 0)}</strong></div><div><span>Broker split</span><strong>−{dollars(Number.isFinite(amounts.split) ? amounts.split : 0)}</strong></div><div><span>Broker fees</span><strong>−{dollars(Number.isFinite(amounts.fees) ? amounts.fees : 0)}</strong></div><div className="commission-net"><span>Amount deposited</span><strong>{dollars(Number.isFinite(net) ? net : 0)}</strong></div></div>
        <p className="muted">The commission is recorded as income. The split and fees are recorded as expenses, so your account activity adds up to the deposit.</p>
        <label>Notes<textarea rows="2" value={form.notes} onChange={event => update('notes', event.target.value)} placeholder="Optional details"/></label>
        <footer><button type="button" className="button subtle" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || net < 0}>{busy ? 'Saving…' : 'Save commission'}</button></footer>
      </form>
    </section>
  </div>;
}
