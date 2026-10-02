import { z } from "zod";
import { SPECIES } from "./spec.ts";
import { HEX_RE, type Palette } from "./launcher.ts";

/**
 * The Brief: what the creature heard, as the one structured document the builder receives (docs/LAUNCHER.md). Shared by the API
 * (validation of the creature's `propose_brief` tool input, the stored proposal, the Slate quote body) and, as a type only, the web.
 * Kept out of the package index so the web bundle never carries zod.
 *
 * Text is model output shaped by untrusted user words: it is length-capped, stripped of control characters, and only ever rendered
 * as text (React text nodes on the scroll; JSON to the builder). It is never HTML and never a URL we follow.
 */

/** Printable text: control characters (C0, C1, bidi overrides and isolates) removed, whitespace collapsed, trimmed. */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, " ").replace(/\s+/g, " ").trim();
}
const text = (max: number) => z.string().transform(cleanText).pipe(z.string().min(1).max(max));
const optText = (max: number) => z.string().transform(cleanText).pipe(z.string().max(max));
const hex = z.string().transform((s) => s.trim().toLowerCase()).pipe(z.string().regex(HEX_RE));

export const PaletteSchema = z.strictObject({ primary: hex, accent: hex, background: hex, text: hex }) satisfies z.ZodType<Palette>;

export const BRIEF_LIMITS = { name: 80, oneLiner: 200, audience: 300, goal: 300, pages: 8, page: 60, sections: 16, section: 80, tone: 120, notes: 2000 } as const;

export const BriefSchema = z.strictObject({
  domain: z.string().min(3).max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
  name: text(BRIEF_LIMITS.name),
  oneLiner: text(BRIEF_LIMITS.oneLiner),
  audience: text(BRIEF_LIMITS.audience),
  goal: text(BRIEF_LIMITS.goal),
  pages: z.array(text(BRIEF_LIMITS.page)).min(1).max(BRIEF_LIMITS.pages),
  sections: z.array(text(BRIEF_LIMITS.section)).max(BRIEF_LIMITS.sections).optional(),
  tone: text(BRIEF_LIMITS.tone),
  palette: PaletteSchema,
  creature: z.strictObject({ species: z.enum(SPECIES), speciesName: z.string().min(1).max(32) }).optional(),
  notes: optText(BRIEF_LIMITS.notes).optional(),
});
export type Brief = z.output<typeof BriefSchema>;

/**
 * The `propose_brief` tool's input: the Brief without the parts the server owns (the domain and the creature are set from the
 * conversation, never by the model). Strict tool use guarantees the shape; lengths and colours are checked here, because the API's
 * strict schemas do not support string-length or pattern constraints. Every property is required (strict tool use), so optional
 * parts arrive as an empty list or string.
 */
export const PROPOSE_BRIEF_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "oneLiner", "audience", "goal", "pages", "sections", "tone", "palette", "notes"],
  properties: {
    name: { type: "string", description: `The site or brand name, at most ${BRIEF_LIMITS.name} characters.` },
    oneLiner: { type: "string", description: `One sentence that says what it is, at most ${BRIEF_LIMITS.oneLiner} characters.` },
    audience: { type: "string", description: `Who it is for, at most ${BRIEF_LIMITS.audience} characters.` },
    goal: { type: "string", description: `What a visitor should do or feel, at most ${BRIEF_LIMITS.goal} characters.` },
    pages: { type: "array", items: { type: "string" }, description: `1 to ${BRIEF_LIMITS.pages} page names, each at most ${BRIEF_LIMITS.page} characters. Usually just "Home".` },
    sections: { type: "array", items: { type: "string" }, description: `Up to ${BRIEF_LIMITS.sections} section names for the pages, in order; may be empty.` },
    tone: { type: "string", description: `The voice and feel in a few words, at most ${BRIEF_LIMITS.tone} characters.` },
    palette: {
      type: "object",
      additionalProperties: false,
      required: ["primary", "accent", "background", "text"],
      description: "Four colours as lowercase #rrggbb. Start from the suggested palette in your instructions unless the owner asked for other colours. Text must stay readable on the background.",
      properties: { primary: { type: "string" }, accent: { type: "string" }, background: { type: "string" }, text: { type: "string" } },
    },
    notes: { type: "string", description: `Anything else the builder must know, at most ${BRIEF_LIMITS.notes} characters; may be empty.` },
  },
} as const;

const ProposedSchema = z.strictObject({
  name: z.string(), oneLiner: z.string(), audience: z.string(), goal: z.string(), pages: z.array(z.string()), sections: z.array(z.string()),
  tone: z.string(), palette: z.unknown(), notes: z.string(),
});

export type BriefCheck = { ok: true; brief: Brief } | { ok: false; problems: string[] };

/**
 * Turn the creature's tool input into a Brief: the server's domain and creature added, an unreadable or invalid palette replaced by
 * the creature's default, empty optional parts dropped. Returns the problems (field names and limits only, never the text) when a
 * field is missing or too long, so the creature can be asked to shorten it.
 */
export function briefFromToolInput(input: unknown, own: { domain: string; creature: { species: (typeof SPECIES)[number]; speciesName: string }; palette: Palette }): BriefCheck {
  const p = ProposedSchema.safeParse(input);
  if (!p.success) return { ok: false, problems: ["the input did not match the propose_brief schema"] };
  const v = p.data;
  const palette = PaletteSchema.safeParse(v.palette);
  const candidate = {
    domain: own.domain, name: v.name, oneLiner: v.oneLiner, audience: v.audience, goal: v.goal, pages: v.pages,
    ...(v.sections.length ? { sections: v.sections } : {}), tone: v.tone,
    palette: palette.success ? palette.data : own.palette,
    creature: own.creature,
    ...(cleanText(v.notes) ? { notes: v.notes } : {}),
  };
  const r = BriefSchema.safeParse(candidate);
  if (r.success) return { ok: true, brief: r.data };
  const problems = r.error.issues.map((i) => {
    const field = i.path.filter((x) => typeof x === "string").join(".") || "brief";
    const lim = (BRIEF_LIMITS as Record<string, number>)[String(i.path[0])];
    return lim !== undefined ? `${field}: required, at most ${lim}${i.path[0] === "pages" || i.path[0] === "sections" ? " items or characters each" : " characters"}` : `${field}: invalid`;
  });
  return { ok: false, problems: [...new Set(problems)] };
}

/** The `revise_site` tool's input: one short instruction in the owner's terms. */
export const REVISE_LIMIT = 500;
export const REVISE_SITE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["instruction"],
  properties: {
    instruction: { type: "string", description: `The change to make, as one concise instruction for the builder, at most ${REVISE_LIMIT} characters. Say what to change, not how to code it.` },
  },
} as const;

export function revisionFromToolInput(input: unknown): { ok: true; instruction: string } | { ok: false; problems: string[] } {
  const r = z.strictObject({ instruction: text(REVISE_LIMIT) }).safeParse(input);
  return r.success ? { ok: true, instruction: r.data.instruction } : { ok: false, problems: [`instruction: required, at most ${REVISE_LIMIT} characters`] };
}
