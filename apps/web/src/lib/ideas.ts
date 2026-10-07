/** Local name inspiration. Descriptions never leave the browser; availability is checked separately. */
const STOP = new Set(['a', 'an', 'the', 'for', 'and', 'of', 'to', 'my', 'i', 'want', 'with', 'business', 'company', 'app', 'website', 'that', 'is']);
export function nameIdeas(description: string): string[] {
  const words = description.toLowerCase().match(/[a-z]{2,20}/g)?.filter(w => !STOP.has(w)) ?? [];
  const roots = [...new Set(words)].slice(0, 3);
  if (!roots.length) return [];
  const a = roots[0]!, b = roots[1];
  return [...new Set([b ? `${a}${b}` : `${a}grove`, `${a}nest`, `${a}glow`, `${a}kind`])].filter(x => x.length <= 63);
}
export function alternativeNames(raw: string): string[] {
  const label = raw.toLowerCase().split('.')[0]!.replace(/[^a-z0-9-]/g, '').slice(0, 45);
  return label ? [`get${label}`, `${label}studio`, `${label}hq`, `hello${label}`] : [];
}
