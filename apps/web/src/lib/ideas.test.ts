import { describe,expect,it } from 'vitest';
import { nameIdeas,alternativeNames } from './ideas';
describe('name inspiration',()=>{
 it('creates bounded unique names without claiming availability',()=>{const names=nameIdeas('a coastal ceramics studio');expect(names).toContain('coastalceramics');expect(new Set(names).size).toBe(names.length);for(const n of names)expect(n).toMatch(/^[a-z]{1,63}$/);});
 it('handles empty, punctuation and oversized inputs',()=>{expect(nameIdeas('the and for')).toEqual([]);expect(alternativeNames('')).toEqual([]);for(const n of alternativeNames('x'.repeat(100)))expect(n.length).toBeLessThanOrEqual(63);});
});
