/**
 * Name ideas from a short description, made in the browser (the description never leaves it). docs/AUDIT-2026-10-07.md D1, D2.
 *
 * The old generator took the first three words of the brief, so "A memorable, friendly name for a children's art studio" became
 * memorablefriendly, memorablenest, memorableglow and memorablekind. This one separates what the brief is about (art, children, studio)
 * from how it should feel (memorable, friendly), maps both to a small hand-written vocabulary, and builds short two-part names that are
 * easy to say and spell. It never claims a name is available, valuable or free of trademarks; the page checks availability separately.
 */

/** Words that carry no subject: filler, and requests about the name itself. */
const FILLER = new Set(("a an the and or for of to in on at by with from into about my our your their its i we you me us it this that these those is are be been " +
  "want need looking look help find make get some something called call named name names naming domain domains website site web online page brand branding " +
  "business company startup shop store service services app apps platform idea ideas project new really very just also like kind sort type " +
  "good great best nice cool perfect simple short easy unique creative modern fresh clever catchy memorable friendly fun playful warm " +
  "professional premium trusted local small big please thanks s people person users user customers clients helps help helping track tracking tracker " +
  "manage managing plan planning planner organize organizer adults adult beginners everyone anyone based located near city town").split(" "));

/** How the brief wants the name to feel, mapped to a tone that picks gentler or crisper word pairs. */
const TONES: Record<string, "warm" | "crisp" | "playful"> = {
  friendly: "warm", warm: "warm", cozy: "warm", cosy: "warm", gentle: "warm", kind: "warm", caring: "warm", welcoming: "warm",
  memorable: "playful", fun: "playful", playful: "playful", whimsical: "playful", cheerful: "playful", happy: "playful", bright: "playful",
  modern: "crisp", professional: "crisp", clean: "crisp", minimal: "crisp", sleek: "crisp", bold: "crisp", smart: "crisp", premium: "crisp",
};

/**
 * Themes: trigger words, the short evocative words a name can use, and the word's role. A "subject" is what the project is about,
 * a "who" is its audience, a "place" says what kind of venture it is. Hand-written, so every word is a real, plain English word.
 */
interface Theme { triggers: string[]; words: string[]; role: "subject" | "who" | "place" }
const THEMES: Theme[] = [
  { role: "subject", triggers: ["art", "arts", "artist", "artists", "paint", "painting", "draw", "drawing", "drawings", "craft", "crafts", "crafting", "illustration", "sketch", "creativity"], words: ["paint", "doodle", "crayon", "color", "brush", "easel", "sketch", "art"] },
  { role: "subject", triggers: ["ceramic", "ceramics", "pottery", "potter", "clay", "kiln"], words: ["clay", "kiln", "glaze", "pottery", "wheel"] },
  { role: "subject", triggers: ["coffee", "cafe", "espresso", "roastery", "roaster", "tea"], words: ["brew", "bean", "roast", "cup", "kettle"] },
  { role: "subject", triggers: ["bakery", "bake", "baking", "bread", "cake", "cakes", "pastry", "cookies", "baker"], words: ["crumb", "loaf", "oven", "dough", "bake"] },
  { role: "subject", triggers: ["garden", "gardening", "gardener", "plant", "plants", "houseplant", "houseplants", "flower", "flowers", "florist", "botanical", "nursery", "succulents"], words: ["bloom", "sprout", "petal", "fern", "leaf"] },
  { role: "subject", triggers: ["coast", "coastal", "ocean", "sea", "beach", "surf", "harbor", "harbour", "island"], words: ["tide", "shore", "wave", "harbor", "salt"] },
  { role: "subject", triggers: ["dog", "dogs", "puppy", "pet", "pets", "cat", "cats", "grooming", "vet"], words: ["paw", "pup", "whisker", "tail", "fetch"] },
  { role: "subject", triggers: ["yoga", "fitness", "gym", "pilates", "running", "wellness", "health", "workout"], words: ["flow", "stride", "pulse", "fit", "breathe"] },
  { role: "subject", triggers: ["music", "song", "songs", "band", "guitar", "piano", "audio", "sound", "podcast"], words: ["tune", "chord", "melody", "note", "beat"] },
  { role: "subject", triggers: ["book", "books", "reading", "writing", "writer", "author", "library", "stories", "story", "poetry"], words: ["page", "story", "chapter", "ink", "quill"] },
  { role: "subject", triggers: ["photo", "photos", "photography", "photographer", "camera", "film", "video"], words: ["lens", "frame", "shutter", "focus", "light"] },
  { role: "subject", triggers: ["food", "kitchen", "cooking", "recipe", "recipes", "chef", "restaurant", "meal", "meals"], words: ["kitchen", "spoon", "table", "pan", "feast"] },
  { role: "subject", triggers: ["travel", "trip", "trips", "adventure", "adventures", "tour", "tours", "hiking", "outdoor", "outdoors"], words: ["trail", "roam", "compass", "path", "voyage"] },
  { role: "subject", triggers: ["software", "code", "coding", "developer", "developers", "tech", "data", "ai", "saas", "api", "tool", "tools"], words: ["code", "stack", "pixel", "byte", "logic"] },
  { role: "subject", triggers: ["finance", "money", "budget", "budgeting", "accounting", "accountant", "accountants", "bookkeeping", "bookkeeper", "payroll", "tax", "taxes", "invest", "investing", "savings"], words: ["ledger", "tally", "coin", "penny", "sum"] },
  { role: "subject", triggers: ["wedding", "weddings", "event", "events", "party", "parties", "celebration"], words: ["toast", "gather", "fete", "confetti", "vow"] },
  { role: "subject", triggers: ["farm", "farms", "farmer", "farmers", "farming", "organic", "harvest", "produce", "vegetables", "orchard", "ranch"], words: ["acre", "harvest", "field", "barn", "grove"] },
  { role: "subject", triggers: ["home", "house", "interior", "interiors", "decor", "furniture", "design"], words: ["nook", "hearth", "room", "home", "loft"] },
  { role: "subject", triggers: ["candle", "candles", "soap", "soaps", "handmade", "knit", "knitting", "sewing", "jewelry", "jewellery"], words: ["wick", "stitch", "thread", "craft", "spark"] },
  { role: "who", triggers: ["children", "child", "kids", "kid", "toddler", "toddlers", "family", "families", "youth", "young", "baby", "babies", "little", "tiny"], words: ["little", "tiny", "kids", "cub", "sprout"] },
  { role: "who", triggers: ["women", "moms", "mothers", "parents", "dads", "seniors", "students", "teens", "community", "neighbors", "neighbours"], words: ["kin", "circle", "village", "crew", "folk"] },
  { role: "place", triggers: ["studio", "studios", "workshop", "workshops", "atelier"], words: ["studio", "lab", "nook", "corner", "workshop"] },
  { role: "place", triggers: ["school", "class", "classes", "lessons", "lesson", "course", "courses", "academy", "tutoring", "camp"], words: ["club", "academy", "school", "camp", "class"] },
  { role: "place", triggers: ["shop", "store", "boutique", "market", "marketplace", "stall"], words: ["shop", "market", "goods", "co", "house"] },
  { role: "place", triggers: ["agency", "consulting", "consultancy", "firm", "services", "collective"], words: ["works", "house", "collective", "co", "partners"] },
];

/** Gentle words a "warm" or "playful" brief may lead with. */
const TONE_LEADS: Record<"warm" | "crisp" | "playful", string[]> = {
  warm: ["happy", "sunny", "kind", "cozy"],
  playful: ["merry", "jolly", "bright", "sunny"],
  crisp: ["true", "clear", "north", "bold"],
};

/** Audience words that read as adjectives: they lead a name ("tinybrush"), never trail it ("brushtiny"). */
const LEADING = new Set(["little", "tiny", "young"]);

const VOWEL = /[aeiouy]/;
/** Consonants at the join of two words, counted across the boundary ("artstudio" joins r-t-s-t: four in a row reads badly). */
function joinConsonants(a: string, b: string): number {
  let n = 0;
  for (let i = a.length - 1; i >= 0 && !VOWEL.test(a[i]!); i--) n++;
  for (let i = 0; i < b.length && !VOWEL.test(b[i]!); i++) n++;
  return n;
}

/** Lower is better. Length, a readable join, no tripled letters, no doubled letter across the join (kidsstudio). */
export function nameCost(parts: string[]): number {
  const name = parts.join("");
  let cost = 0;
  if (name.length > 14) cost += (name.length - 14) * 3;
  if (name.length < 6) cost += (6 - name.length) * 2;
  cost += Math.abs(name.length - 10) * 0.4;
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i - 1]!, b = parts[i]!;
    const j = joinConsonants(a, b);
    if (j >= 4) cost += 6; else if (j === 3) cost += 2.5;
    if (a[a.length - 1] === b[0]) cost += 4;
  }
  if (/(.)\1\1/.test(name)) cost += 10;
  if (parts.length > 2) cost += 2;
  return cost;
}

function words(brief: string): string[] {
  return (brief.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z]+/g) ?? []).filter((w) => w.length >= 2 && w.length <= 20);
}

export interface Idea { label: string; parts: string[] }

/**
 * Up to `max` name ideas for a brief, best first, varied (no word leads more than twice). Deterministic: the same brief always gives the
 * same list. Labels are 3 to 20 lowercase letters, no digits or hyphens.
 */
export function ideasFor(brief: string, max = 10): Idea[] {
  const ws = words(brief);
  if (!ws.length) return [];
  const tone = ws.map((w) => TONES[w]).find(Boolean) ?? "warm";
  const hits = (role: Theme["role"]) => THEMES.filter((t) => t.role === role && t.triggers.some((tr) => ws.includes(tr)));
  const subjects = hits("subject"), who = hits("who"), place = hits("place");
  // Words of the brief that match no theme but look like a real root (a proper noun, a niche subject): usable as they are.
  const known = new Set(THEMES.flatMap((t) => t.triggers));
  const loose = [...new Set(ws.filter((w) => !FILLER.has(w) && !TONES[w] && !known.has(w) && w.length >= 3 && w.length <= 9 && VOWEL.test(w)))].slice(0, 3);
  const subjectWords = [...new Set([...subjects.flatMap((t) => t.words), ...loose])];
  const whoWords = who.flatMap((t) => t.words);
  const placeWords = place.flatMap((t) => t.words);
  if (!subjectWords.length && !whoWords.length && !placeWords.length) return [];
  const leads = TONE_LEADS[tone];
  const raw: string[][] = [];
  const add = (...p: string[]) => { if (p.every(Boolean)) raw.push(p); };
  const subj = subjectWords.length ? subjectWords : placeWords;
  const loneSubjects = new Set(loose);
  for (const s of subj) {
    for (const w of whoWords) { if (LEADING.has(w)) add(w, s); else { add(s, w); add(w, s); } }
    for (const p of placeWords) add(s, p);
    // A word from the brief that matched no theme (a town, a proper noun) pairs with the subject vocabulary, not with mood words.
    if (!loneSubjects.has(s)) for (const l of leads) add(l, s);
    for (const lo of loose) if (lo !== s && !loneSubjects.has(s)) add(lo, s);
  }
  // Two different subjects (farms and bookkeeping): one word from each, the more concrete one first.
  for (let i = 0; i < subjects.length; i++) for (let j = 0; j < subjects.length; j++) {
    if (i === j) continue;
    for (const a of subjects[i]!.words.slice(0, 3)) for (const b of subjects[j]!.words.slice(0, 3)) add(a, b);
  }
  for (const w of whoWords) for (const p of placeWords) if (!LEADING.has(w) || p !== "co") add(w, p);
  // Three parts only when a subject, an audience and a venture all appear (kids + art + studio): the plain descriptive name.
  if (subjects.length && who.length && place.length) add(whoWords.includes("kids") ? "kids" : whoWords[0]!, subjects[0]!.words.at(-1)!, placeWords[0]!);
  // Only words of the brief that match no theme (a made-up name): the name itself with a plain venture word.
  if (!subjects.length && !who.length && !place.length) for (const lo of loose) for (const p of ["studio", "co", "hq", "lab"]) add(lo, p);
  const seen = new Set<string>();
  const scored = raw
    .filter((p) => p[0] !== p[1])
    .map((p) => ({ label: p.join(""), parts: p, cost: nameCost(p) }))
    .filter((x) => /^[a-z]{3,20}$/.test(x.label) && !seen.has(x.label) && (seen.add(x.label), true))
    .sort((a, b) => a.cost - b.cost || a.label.localeCompare(b.label));
  const out: Idea[] = []; const lead = new Map<string, number>(); const tail = new Map<string, number>();
  for (const x of scored) {
    const f = x.parts[0]!, l = x.parts.at(-1)!;
    if ((lead.get(f) ?? 0) >= 2 || (tail.get(l) ?? 0) >= 2) continue;
    lead.set(f, (lead.get(f) ?? 0) + 1); tail.set(l, (tail.get(l) ?? 0) + 1);
    out.push({ label: x.label, parts: x.parts });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Names close to one that is taken (D2): common, honest variations a person might accept, best first. Short affixes only, never
 * misspellings. The page checks each one and shows only those that look free, with a reminder about other people's brands.
 */
export function similarNames(raw: string, brief = "", max = 8): string[] {
  const label = raw.toLowerCase().split(".")[0]!.replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!label) return [];
  const fromBrief = brief ? ideasFor(brief, 6).flatMap((i) => i.parts).filter((p) => p !== label) : [];
  const parts: string[][] = [
    ["get", label], [label, "hq"], ["hello", label], [label, "studio"], ["try", label], [label, "co"], ["the", label], [label, "app"], ["join", label], [label, "club"],
    ...fromBrief.slice(0, 4).map((w) => [label, w]),
  ];
  const seen = new Set<string>();
  return parts
    .map((p) => ({ label: p.join(""), cost: nameCost(p) }))
    .filter((x) => x.label.length <= 63 && x.label !== label && !seen.has(x.label) && (seen.add(x.label), true))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, max)
    .map((x) => x.label);
}
