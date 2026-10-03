import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {previewPrices} from './preview-prices.mjs';
const fees=readFileSync(new URL('../apps/web/public/fees.html',import.meta.url),'utf8');
describe('published preview prices',()=>{
  it('uses registration and renewal amounts from the published table',()=>{
    const prices=previewPrices();
    expect(prices).toHaveLength(6);
    expect(prices.find(p=>p.tld==='com')).toEqual({tld:'com',price:'$20.98',years:1,renewal:'$20.98'});
    expect(prices.find(p=>p.tld==='ai')).toEqual({tld:'ai',price:'$288.00',years:2,renewal:'$288.00'});
    const changed=fees.replace('data-kind="register">$20.98','data-kind="register">$21.01');
    expect(previewPrices(changed)[0].price).toBe('$21.01');
    expect(previewPrices(changed)[0].renewal).toBe('$20.98');
  });
  it('fails the build for absent, duplicate or malformed published examples',()=>{
    for(const broken of [fees.replace('data-fee-table','nothing'),fees.replace('data-tld="dev"','data-tld="com"'),fees.replace('data-kind="register">$20.98','data-kind="register">unknown')]) expect(()=>previewPrices(broken)).toThrow();
  });
});
