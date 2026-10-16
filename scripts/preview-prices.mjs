import { readFileSync } from 'node:fs';

// The published Fees table owns the preview examples too. No adapter mock quotes
// or build-date label can silently create another customer-facing price list.
export function previewPrices(html = readFileSync(new URL('../apps/web/public/fees.html', import.meta.url), 'utf8')) {
  const table = /<table\b[^>]*data-fee-table[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) throw new Error('Published Fees table is missing');
  const rows = [...table.matchAll(/<tr\b[^>]*data-tld="([a-z]+)"[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rows.length !== 6 || new Set(rows.map(r => r[1])).size !== rows.length) throw new Error('Published Fees table must contain six unique extensions');
  return rows.map(([, tld, row]) => {
    function amount(kind) {
      const text = new RegExp(`<td\\b[^>]*data-kind="${kind}"[^>]*>([^<]*)<\\/td>`, 'i').exec(row)?.[1]?.trim();
      const match = /^\$(\d+\.\d{2}) (a year|for 2 years)(?: \(2 years minimum\))?$/.exec(text || '');
      if (!match || Number(match[1]) <= 0) throw new Error(`Invalid published ${kind} price for .${tld}`);
      return {price:'$' + match[1],years:match[2] === 'a year' ? 1 : 2};
    }
    const register = amount('register'), renew = amount('renew');
    if (register.years !== renew.years) throw new Error(`Mismatched published periods for .${tld}`);
    return {tld,price:register.price,years:register.years,renewal:renew.price};
  });
}
