/**
 * Exact inbound-DM keyword matching.
 *
 * Inbound campaigns deliberately accept one token only. This keeps normal
 * customer messages in SAV while still accepting harmless variations such as
 * case, full-width characters, a single leading hashtag, or one sentence mark.
 */

export interface InboundDmCandidate {
  id: string;
  keywords: string[];
}

export interface InboundDmMatch<T extends InboundDmCandidate> {
  automation: T;
  matchedKeyword: string;
  normalizedKeyword: string;
}

const EXACT_TOKEN_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;
const TERMINAL_PUNCTUATION_PATTERN = /[.!?]$/u;

/**
 * Return the canonical exact token, or null when the message is not an
 * automation command. Attachments always keep the message in the SAV path.
 */
export function normalizeInboundDmKeyword(
  text: string,
  hasAttachments = false
): string | null {
  if (hasAttachments) return null;

  let value = text.normalize("NFKC").trim().toLowerCase();
  if (!value) return null;

  if (value.startsWith("#")) value = value.slice(1);
  if (TERMINAL_PUNCTUATION_PATTERN.test(value)) value = value.slice(0, -1);

  if (!value || value.length > 50 || !EXACT_TOKEN_PATTERN.test(value)) {
    return null;
  }

  return value;
}

export function normalizeInboundDmKeywords(keywords: string[]): {
  normalized: string[];
  invalid: string[];
  duplicates: string[];
} {
  const normalized: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const keyword of keywords) {
    const value = normalizeInboundDmKeyword(keyword);
    if (!value) {
      invalid.push(keyword);
      continue;
    }
    if (seen.has(value)) {
      duplicates.push(keyword);
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return { normalized, invalid, duplicates };
}

export function matchInboundDmAutomations<T extends InboundDmCandidate>(
  candidates: T[],
  text: string,
  hasAttachments = false
): InboundDmMatch<T>[] {
  const normalizedKeyword = normalizeInboundDmKeyword(text, hasAttachments);
  if (!normalizedKeyword) return [];

  const matches: InboundDmMatch<T>[] = [];
  for (const automation of candidates) {
    const matchedKeyword = automation.keywords.find(
      (keyword) => normalizeInboundDmKeyword(keyword) === normalizedKeyword
    );
    if (matchedKeyword) {
      matches.push({ automation, matchedKeyword, normalizedKeyword });
    }
  }
  return matches;
}
