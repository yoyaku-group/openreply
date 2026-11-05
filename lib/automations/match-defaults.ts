/**
 * Comment matcher defaults.
 *
 * YOYAKU never asks for a specific word: anyone who comments receives the
 * private message. A new comment campaign therefore starts on `any`. An
 * inbound DM campaign is the exception, because the person does send a word to
 * us: it starts on `specific`.
 *
 * The catalogue scope identifies the future post; it never touches the comment
 * matcher. The functions here are pure so the builder stays thin and the
 * defaults are testable without a DOM.
 */

export type MatchMode = "any" | "specific";
export type TriggerType = "COMMENT" | "INBOUND_DM";
export type TriggerScope = "specific" | "any" | "next" | "catalogue";
export type BuilderMode = "new" | "edit";

export interface MatcherState {
  matchMode: MatchMode;
  keywordText: string;
}

/** Starting matcher for a campaign being created. */
export function defaultMatcher(triggerType: TriggerType): MatcherState {
  return {
    matchMode: triggerType === "INBOUND_DM" ? "specific" : "any",
    keywordText: "",
  };
}

/**
 * Matcher for a CSV import row: a filled keyword column keeps a specific word,
 * an empty one means every comment qualifies.
 */
export function matcherFromKeywords(keywords: string[]): MatcherState {
  const keywordText = keywords
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .join(", ");
  return {
    matchMode: keywordText ? "specific" : "any",
    keywordText,
  };
}

export type MatcherEvent =
  | { kind: "triggerType"; triggerType: TriggerType; from: TriggerType }
  | { kind: "triggerScope"; scope: TriggerScope };

/**
 * Next matcher state for a builder interaction.
 *
 * Selecting a trigger scope (including the catalogue one) leaves the matcher
 * alone. Re-selecting the trigger type a campaign is already on leaves it alone
 * too: the radios fire their click handler even when already checked, and a
 * second click must not discard a word the operator just typed. Switching the
 * trigger type applies the create defaults on a new campaign and keeps the
 * stored values on an existing one, so a campaign saved with a specific word
 * still opens and saves with that word.
 */
export function nextMatcher(
  current: MatcherState,
  event: MatcherEvent,
  mode: BuilderMode
): MatcherState {
  if (event.kind === "triggerScope") return current;
  if (event.triggerType === event.from) return current;
  if (mode === "edit") return current;
  return defaultMatcher(event.triggerType);
}
