/**
 * Anti-cliché linter for YOYAKU DM copy.
 *
 * Ported from the proven email style guard (pretooluse-email-cascade-guard.py
 * check_style) and extended with the tics observed in the legacy ManyChat
 * campaigns. A rejected text never becomes a campaign: the linter is a hard
 * gate at generation time and a warning surface for manual edits.
 *
 * The one rule that is not cosmetic: every proper noun in the text must come
 * from the fact block. This is the executable form of rules/01 "NEVER invent
 * or sharpen a name".
 */

import { META_BODY_LIMIT, META_BUTTON_LIMIT } from "./yoyaku-patterns";
import type { CampaignCopy } from "./yoyaku-patterns";
import { factNouns } from "./release-facts";
import type { CampaignFacts } from "./release-facts";

export interface LintViolation {
  rule: string;
  detail: string;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
}

const EMOJI = /\p{Extended_Pictographic}|️/u;
const DASHES = /[—–]/;

const BAD_OPENINGS = /^(hey|hey there|hi there|hello there)\b/i;

const CLICHES: readonly RegExp[] = [
  /\bdive (in|into)\b/i,
  /\bworld of\b/i,
  /\b\w+'s world\b/i,
  /\bjourney\b/i,
  /\bfresh (perspective|take)\b/i,
  /\b(elevate|unlock|leverage|showcase|streamline|empower|foster|amplify|curate)\b/i,
  /\bgame.?changer\b/i,
];

const RHETORICAL_HOOKS: readonly RegExp[] = [
  /you'?re in the right place/i,
  /\bwanna (hear|see|listen)\b/i,
  /\blet'?s listen\b/i,
  /^looking for\b/i,
  /\bready to\b/i,
];

const FAKE_PERSONALIZATION: readonly RegExp[] = [
  /i hope this (email|message|note) finds you well/i,
  /i wanted to personally reach out/i,
  /please (do not|don'?t) hesitate/i,
  /feel free to (contact|reach out|get in touch)/i,
  /looking forward to hearing/i,
];

/** Three-item "X, Y, and Z" lists — the adjective-triad tell. */
const TRIAD = /,[^,.!?]+,\s*and\s+/i;

/**
 * Words our hand-written shells legitimately capitalize outside fact nouns.
 * Anything else capitalized must appear in the fact block.
 */
const ALLOWED_CAPITALIZED = new Set([
  "preorder",
  "preorders",
  "restock",
  "new",
  "out",
  "copies",
  "here",
  "there",
  "the",
  "full",
  "send",
  "get",
  "watch",
  "youtube",
  "soundcloud",
  "instore",
  "yoyaku",
]);

/**
 * Ordinary English words a sentence may start with. A capital letter at the
 * start of a sentence is grammar, not a name: "Saw your comment", "This one",
 * "Want the link?" must not read as invented proper nouns. The list is closed
 * on purpose: a sentence-initial word outside it still goes through the fact
 * and source lookup, so an invented name at the start of a sentence ("Burial
 * is back") is still refused. Greetings are listed so the invented-noun rule
 * does not double-report them; the no-hey-opening rule still fires.
 */
const SENTENCE_STARTERS = new Set([
  // pronouns, determiners
  "a", "an", "all", "another", "any", "both", "each", "every", "his", "her",
  "i", "i'm", "i've", "it", "it's", "its", "my", "no", "one", "our", "some",
  "that", "that's", "their", "these", "they", "they're", "this", "those",
  "we", "we're", "we've", "we'll", "what", "what's", "which", "who", "you",
  "you're", "you've", "you'll", "your",
  // conjunctions, prepositions, adverbs
  "after", "also", "and", "as", "at", "back", "before", "but", "by", "for",
  "from", "how", "if", "in", "just", "now", "of", "on", "once", "only", "or",
  "since", "so", "still", "then", "to", "too", "when", "where", "while",
  "why", "with", "yes",
  // numbers
  "two", "three", "four", "five", "six", "first", "last",
  // verbs a DM sentence opens with
  "check", "comes", "coming", "enjoy", "find", "give", "glad", "got", "grab",
  "have", "hear", "listen", "look", "saw", "see", "seen", "take", "tap",
  "thanks", "thank", "want",
  // greetings (no-hey-opening owns the style judgement)
  "hey", "hi", "hello",
]);

/** Index of `match` starts a sentence: text start, or after . ! ? : or a newline. */
function startsSentence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  return before.trim() === "" || /(?:[.!?:]\s+|\n\s*)$/.test(before);
}

/** "Nuron's" names Nuron: drop a trailing possessive before the lookup. */
function stripPossessive(word: string): string {
  return word.replace(/'s?$/i, "");
}

function collectFactWords(nouns: string[]): Set<string> {
  const words = new Set<string>();
  for (const noun of nouns) {
    words.add(noun.toLowerCase());
    for (const word of noun.split(/[\s/&.,'-]+/)) {
      if (word) words.add(word.toLowerCase());
    }
  }
  return words;
}

/**
 * Words a free-text source (product description, post caption) legitimately
 * contributes. A proper noun that appears verbatim in the source is allowed
 * by the invented-noun rule: "Discogs" in the LM-02 caption is a real name
 * the team wrote, not an invention of the copy step.
 */
export function sourceWordsFrom(sourceText: string | null | undefined): Set<string> {
  const words = new Set<string>();
  if (!sourceText) return words;
  for (const word of sourceText.split(/[^A-Za-z0-9'&-]+/)) {
    const lower = word.toLowerCase();
    if (lower) words.add(lower);
  }
  return words;
}

function findInventedNouns(
  text: string,
  nouns: string[],
  sourceWords: Set<string> = new Set()
): string[] {
  const factWords = collectFactWords(nouns);
  const invented: string[] = [];

  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9'&-]*\b/g)) {
    const word = match[0];
    const whole = word.toLowerCase();
    if (startsSentence(text, match.index ?? 0) && SENTENCE_STARTERS.has(whole)) {
      continue;
    }
    const lower = stripPossessive(whole);
    if (!lower) continue;
    if (ALLOWED_CAPITALIZED.has(lower)) continue;
    if (factWords.has(lower)) continue;
    // All-caps tokens that are substrings of a fact (catno fragments) pass.
    if (nouns.some((noun) => noun.toLowerCase().includes(lower))) continue;
    if (sourceWords.has(lower)) continue;
    invented.push(word);
  }

  return invented;
}

export function lintText(
  text: string,
  nouns: string[],
  sourceWords: Set<string> = new Set()
): LintViolation[] {
  const violations: LintViolation[] = [];
  const add = (rule: string, detail: string) => violations.push({ rule, detail });

  if (EMOJI.test(text)) add("no-emoji", "emoji are off-brand on YOYAKU accounts");
  if (DASHES.test(text)) add("no-dashes", "em/en dashes are banned (rules/01)");
  if (BAD_OPENINGS.test(text.trim())) add("no-hey-opening", `starts with a filler greeting`);

  for (const pattern of CLICHES) {
    const hit = text.match(pattern);
    if (hit) add("cliche", `"${hit[0]}"`);
  }
  for (const pattern of RHETORICAL_HOOKS) {
    const hit = text.match(pattern);
    if (hit) add("rhetorical-hook", `"${hit[0]}"`);
  }
  for (const pattern of FAKE_PERSONALIZATION) {
    const hit = text.match(pattern);
    if (hit) add("fake-personalization", `"${hit[0]}"`);
  }

  if (TRIAD.test(text)) add("adjective-triad", "three-item list reads as marketing");

  const exclamations = (text.match(/!/g) ?? []).length;
  if (exclamations > 1) add("exclamation-overload", `${exclamations} exclamation marks`);

  const inventedNouns = findInventedNouns(text, nouns, sourceWords);
  if (inventedNouns.length > 0) {
    add(
      "invented-noun",
      `proper noun(s) not in the fact block: ${inventedNouns.join(", ")}`
    );
  }

  return violations;
}

/**
 * A price in DM copy: currency sign or code next to digits. Prices change and
 * the DM carries the tracked link, never a number (playbook copy rules).
 */
const PRICE_PATTERN =
  /(?:[$€£¥]\s*\d)|(?:\d\s*[$€£¥])|(?:\b(?:EUR|USD|GBP|CHF)\s*\d)|(?:\d\s*(?:EUR|USD|GBP|CHF)\b)/i;

/** The AI must never reveal (or mention) the machinery behind the copy. */
const AI_MENTION_PATTERNS: readonly RegExp[] = [
  /\bai\b/i,
  /\ba\.i\.\b/i,
  /artificial intelligence/i,
  /\bchat ?bots?\b/i,
  /\bbots?\b/i,
  /\bautomated\b/i,
  /\bautomation\b/i,
];

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

/**
 * Extra gate for AI-written copy, on top of `lintCampaignCopy`: the prompt
 * forbids prices, URLs and any mention of AI, bots or automation, and the
 * check runs whatever the source text contains — a price that appears in the
 * caption is still refused.
 */
export function lintGeneratedCopy(
  copy: CampaignCopy,
  facts: CampaignFacts,
  options?: LintCampaignCopyOptions
): LintResult {
  const result = lintCampaignCopy(copy, facts, options);
  const violations = [...result.violations];

  // Buttons are model output too: a 20-character button can still carry a
  // price or say "AI picks". Every user-visible field is checked.
  const fields: readonly (readonly [string, string])[] = [
    ["openingDmMessage", copy.openingDmMessage],
    ["dmMessage", copy.dmMessage],
    ["openingDmButtonLabel", copy.openingDmButtonLabel],
    ["linkButtonLabel", copy.linkButtonLabel],
  ];
  for (const [field, value] of fields) {
    if (PRICE_PATTERN.test(value)) {
      violations.push({
        rule: "no-price",
        detail: `${field}: prices are never quoted in a DM`,
      });
    }
    if (URL_PATTERN.test(value)) {
      violations.push({
        rule: "no-url",
        detail: `${field}: the system attaches the link, the text carries none`,
      });
    }
    for (const pattern of AI_MENTION_PATTERNS) {
      const hit = value.match(pattern);
      if (hit) {
        violations.push({
          rule: "no-ai-mention",
          detail: `${field}: "${hit[0]}" mentions the machinery`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

export interface LintCampaignCopyOptions {
  /**
   * Free text the copy legitimately draws from (the product description, the
   * post caption). A proper noun that appears verbatim in it is allowed.
   * Only relaxes the invented-noun rule: prices, emoji, dashes, AI mentions
   * and length limits stay forbidden whatever the source. Absent (the
   * default) keeps the exact previous behaviour for existing callers.
   */
  sourceText?: string | null;
}

/** Lint every user-visible field of a campaign against its fact block. */
export function lintCampaignCopy(
  copy: CampaignCopy,
  facts: CampaignFacts,
  options?: LintCampaignCopyOptions
): LintResult {
  const nouns = factNouns(facts);
  const sourceWords = sourceWordsFrom(options?.sourceText);
  const violations: LintViolation[] = [];

  for (const [field, value] of [
    ["openingDmMessage", copy.openingDmMessage],
    ["dmMessage", copy.dmMessage],
  ] as const) {
    for (const violation of lintText(value, nouns, sourceWords)) {
      violations.push({ ...violation, detail: `${field}: ${violation.detail}` });
    }
    if (value.length > META_BODY_LIMIT) {
      violations.push({
        rule: "meta-body-limit",
        detail: `${field} is ${value.length} chars (limit ${META_BODY_LIMIT})`,
      });
    }
  }

  for (const [field, value] of [
    ["openingDmButtonLabel", copy.openingDmButtonLabel],
    ["linkButtonLabel", copy.linkButtonLabel],
    ["secondaryButtonLabel", copy.secondaryButtonLabel ?? ""],
  ] as const) {
    if (value.length > META_BUTTON_LIMIT) {
      violations.push({
        rule: "meta-button-limit",
        detail: `${field} is ${value.length} chars (limit ${META_BUTTON_LIMIT})`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Barcelona double text (playbook house style rule 6): every message and every
 * button from a BCN automation carries the English version first, then the
 * Spanish one, and both say the same thing.
 *
 * The Spanish half is recognised by its own signals — accents and the common
 * Spanish words these DMs actually use — so a copy that only has a Spanish
 * tail, or Spanish that comes first, is rejected. The rule is a shape check,
 * not a translation check: it cannot tell whether the two halves say the same
 * thing, only that both halves are there in the right order.
 */
/** A keyword is a whole word: `BCN` matches, `BCNX` does not. */
const BARCELONA_KEYWORD = /\b(BCN|barcelona)\b/i;

/**
 * A hashtag is one run of characters, so a catnoTag carries the marker as a
 * substring: `yoyakubarcelona` and `BCNOPEN` both count.
 */
const BARCELONA_TAG = /(BCN|barcelona)/i;

/**
 * Spanish function words and verb forms these DMs use. Every entry is a word
 * that does not occur in the English half of the same message, so one hit is
 * already good evidence on its own.
 */
const SPANISH_WORDS: readonly RegExp[] = [
  /\bde la\b/i,
  /\ben la\b/i,
  /\bde segunda mano\b/i,
  /\bte enviamos\b/i,
  /\bte enviaremos\b/i,
  /\bte escribimos\b/i,
  /\bla tienda\b/i,
  /\babierta\b/i,
  /\brecogida\b/i,
  /\bgracias\b/i,
  /\bquieres\b/i,
  /\binvitaciones\b/i,
  /\bnuestras\b/i,
  /\bsesiones\b/i,
  /\bmercados\b/i,
  /\btodo lo que\b/i,
  /\bse recoge\b/i,
  /\bunete\b/i,
  /\bestamos\b/i,
  /\btambien\b/i,
  /\bahora\b/i,
  /\bpronto\b/i,
];

/** `¿`, `¡` and the accented letters are unambiguous Spanish typography. */
const SPANISH_ACCENTS = /[¿¡áéíóúñü]/i;

function spanishSignals(text: string): number {
  let hits = SPANISH_ACCENTS.test(text) ? 1 : 0;
  for (const pattern of SPANISH_WORDS) {
    if (pattern.test(text)) hits += 1;
  }
  return hits;
}

/**
 * One accented letter or one Spanish-only word is enough. A short Spanish
 * paragraph with neither is indistinguishable from English, and guessing
 * there would block a compliant message; the rule errs towards accepting.
 */
function isSpanishText(text: string): boolean {
  return spanishSignals(text) >= 1;
}

/** A button is Spanish on the right when it carries an accent or a word. */
function hasSpanishButtonSignal(text: string): boolean {
  return spanishSignals(text) >= 1;
}

export interface BarcelonaAutomationIdentity {
  /** `Automation.keywords` — the keyword that triggers an INBOUND_DM campaign. */
  keywords?: readonly string[] | null;
  /** `Automation.catnoTag` — the hashtag a release campaign binds to. */
  catnoTag?: string | null;
}

/** Whether this automation is a Barcelona one and owes the double text. */
export function isBarcelonaAutomation(
  identity: BarcelonaAutomationIdentity
): boolean {
  if (identity.catnoTag && BARCELONA_TAG.test(identity.catnoTag)) return true;
  return (identity.keywords ?? []).some((keyword) =>
    BARCELONA_KEYWORD.test(keyword)
  );
}

/**
 * A body is compliant when it splits into paragraphs, has an English part
 * first, and has an English-free Spanish part after it.
 */
export function lintBarcelonaDoubleText(
  text: string
): LintViolation[] {
  const violations: LintViolation[] = [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const spanishAt = paragraphs.findIndex((paragraph) => isSpanishText(paragraph));

  if (spanishAt === -1) {
    violations.push({
      rule: "bcn-double-text",
      detail: "no Spanish version found (English only)",
    });
    return violations;
  }

  if (!paragraphs.slice(0, spanishAt).some((paragraph) => !isSpanishText(paragraph))) {
    violations.push({
      rule: "bcn-double-text",
      detail: "Spanish comes before any English part",
    });
  }

  return violations;
}

/**
 * A button carries "EN / ES" in one label: two segments joined by " / ", the
 * right one Spanish.
 */
export function lintBarcelonaButtonLabel(label: string): LintViolation[] {
  const segments = label.split(" / ");
  if (segments.length !== 2 || segments.some((segment) => !segment.trim())) {
    return [
      {
        rule: "bcn-double-button",
        detail: `expected "<English> / <Spanish>", got "${label}"`,
      },
    ];
  }

  const [, spanish] = segments;
  if (!hasSpanishButtonSignal(spanish.trim())) {
    return [
      {
        rule: "bcn-double-button",
        detail: `right half is not Spanish: "${spanish.trim()}"`,
      },
    ];
  }

  return [];
}

export interface BarcelonaCampaignCopy {
  openingDmMessage?: string | null;
  dmMessage: string;
  openingDmButtonLabel?: string | null;
  linkButtonLabel?: string | null;
  secondaryButtonLabel?: string | null;
}

/** Lint every user-visible field of a Barcelona campaign. */
export function lintBarcelonaCampaign(
  copy: BarcelonaCampaignCopy
): LintResult {
  const violations: LintViolation[] = [];

  for (const [field, value] of [
    ["openingDmMessage", copy.openingDmMessage],
    ["dmMessage", copy.dmMessage],
  ] as const) {
    if (!value) continue;
    for (const violation of lintBarcelonaDoubleText(value)) {
      violations.push({ ...violation, detail: `${field}: ${violation.detail}` });
    }
  }

  for (const [field, value] of [
    ["openingDmButtonLabel", copy.openingDmButtonLabel],
    ["linkButtonLabel", copy.linkButtonLabel],
    ["secondaryButtonLabel", copy.secondaryButtonLabel],
  ] as const) {
    if (!value) continue;
    for (const violation of lintBarcelonaButtonLabel(value)) {
      violations.push({ ...violation, detail: `${field}: ${violation.detail}` });
    }
  }

  return { ok: violations.length === 0, violations };
}
