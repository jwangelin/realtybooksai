export function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(value); value = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[i + 1] === '\n') i++;
      row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
      row = []; value = '';
    } else value += character;
  }
  row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

export function parseDate(value) {
  const input = String(value || '').trim();
  let parts = input.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (parts) return validDate(+parts[1], +parts[2], +parts[3]);
  parts = input.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (parts) return validDate(+parts[3] < 100 ? 2000 + +parts[3] : +parts[3], +parts[1], +parts[2]);
  return null;
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

export function parseMoney(value) {
  const input = String(value ?? '').trim();
  if (!input) return 0;
  const negative = input.startsWith('-') || /^\(.*\)$/.test(input);
  const number = Number(input.replace(/[$,()\s+-]/g, ''));
  if (!Number.isFinite(number)) return NaN;
  return Math.round(number * 100) * (negative ? -1 : 1);
}

const headerMatch = (header, names) => header.findIndex(value => names.some(name => value.includes(name)));

export function rowsFromCsv(text) {
  const raw = parseCsv(text);
  const headerIndex = raw.findIndex(row => row.some(cell => /date/i.test(cell)) && row.some(cell => /amount|debit|credit|withdrawal|deposit/i.test(cell)));
  if (headerIndex < 0) throw Error('Could not find Date and Amount columns. Export a transaction CSV from your bank.');
  const headers = raw[headerIndex].map(cell => cell.trim().toLowerCase());
  const date = headerMatch(headers, ['date']);
  const description = headerMatch(headers, ['description', 'memo', 'details', 'merchant', 'payee', 'name']);
  const amount = headerMatch(headers, ['amount']);
  const debit = headerMatch(headers, ['debit', 'withdrawal', 'money out']);
  const credit = headerMatch(headers, ['credit', 'deposit', 'money in']);
  if (description < 0 || (amount < 0 && debit < 0 && credit < 0)) throw Error('The file needs a description and an amount, or debit and credit columns.');
  return raw.slice(headerIndex + 1).map((cells, index) => {
    const posted_on = parseDate(cells[date]);
    const amount_cents = amount >= 0 ? parseMoney(cells[amount]) : parseMoney(cells[credit]) - parseMoney(cells[debit]);
    return {posted_on, description: String(cells[description] || '').trim(), amount_cents, line: index + headerIndex + 2};
  }).filter(row => row.posted_on && row.description && Number.isSafeInteger(row.amount_cents) && row.amount_cents !== 0);
}

export async function rowsFromPdf(file) {
  const [{getDocument, GlobalWorkerOptions}, {default: workerUrl}] = await Promise.all([
    import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await getDocument({data: bytes, isEvalSupported: false}).promise;
  const rows = [];
  let yearHint = file.name.match(/20\d{2}/)?.[0] || null;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    yearHint ||= content.items.map(item => item.str || '').join(' ').match(/20\d{2}/)?.[0] || null;
    const lines = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      const line = lines.get(y) || [];
      line.push({x: item.transform[4], text: item.str.trim()});
      lines.set(y, line);
    }
    for (const [, parts] of [...lines].sort((a, b) => b[0] - a[0])) {
      const text = parts.sort((a, b) => a.x - b.x).map(part => part.text).join(' ');
      const match = text.match(/^(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2})\s+(.+?)\s+([(-]?[\d,]+\.\d{2}\)?)\s*(?:[(-]?[\d,]+\.\d{2}\)?)?$/);
      if (!match) continue;
      const posted_on = parseDate(match[1].match(/^[0-9]{1,2}[/-][0-9]{1,2}$/) && yearHint ? `${match[1]}/${yearHint}` : match[1]);
      const amount_cents = parseMoney(match[3]);
      if (posted_on && Number.isSafeInteger(amount_cents) && amount_cents !== 0) rows.push({posted_on, description: match[2], amount_cents, line: `${pageNumber}:${rows.length + 1}`});
    }
  }
  if (!rows.length) throw Error('No transaction rows could be read from this PDF. Scanned statements need a bank CSV export.');
  return rows;
}

export async function rowFingerprint(row) {
  const value = `${row.posted_on}|${row.description}|${row.amount_cents}|${row.line}`;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
