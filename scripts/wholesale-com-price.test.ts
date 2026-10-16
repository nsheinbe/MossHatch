import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';

type Row={kind:string,minor:number,from:string};
function comRows(file:string):Row[]{
  const sql=readFileSync(new URL(file,import.meta.url),'utf8');
  return [...sql.matchAll(/\('openprovider',\s*'com',\s*'(register|renew|transfer)',\s*(\d+),\s*'([0-9-]+)'/g)]
    .map(m=>({kind:m[1],minor:Number(m[2]),from:m[3]}));
}
const rows=[...comRows('../packages/db/migrations/1220_openprovider_member_prices.sql'),
            ...comRows('../packages/db/migrations/1230_openprovider_com_verisign_2026_11.sql')];
function inForce(date:string,kind:string):Row|undefined{
  return rows.filter(r=>r.kind===kind&&r.from<=date).sort((a,b)=>a.from<b.from?-1:1).at(-1);
}

describe('dated .com wholesale prices (Verisign increase 2026-11-01)',()=>{
  it('keeps $10.46 in force through 2026-10-31 for register, renew and transfer',()=>{
    for(const kind of ['register','renew','transfer']) expect(inForce('2026-10-31',kind)?.minor).toBe(1046);
  });
  it('puts $11.17 in force from 2026-11-01 for register, renew and transfer',()=>{
    for(const kind of ['register','renew','transfer']) expect(inForce('2026-11-01',kind)?.minor).toBe(1117);
  });
  it('announces the $14.17 retail price on the fees page while the table keeps $13.46 today',()=>{
    const fees=readFileSync(new URL('../apps/web/public/fees.html',import.meta.url),'utf8');
    expect(fees).toContain('from 1 November 2026 our .com price becomes $14.17 a year');
    expect(fees).toContain('data-tld="com"');
    expect(fees).toContain('$13.46 a year');
  });
});
