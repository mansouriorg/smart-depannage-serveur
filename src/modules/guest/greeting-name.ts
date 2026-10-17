/**
 * The name a visitor typed, as it may appear in a message sent to somebody
 * else's mailbox (and in templates the team edits): a name and nothing else.
 *
 * Letters (any alphabet), accents, spaces, hyphens, apostrophes and dots, at most
 * 4 words and 40 characters. Anything else (digits, a comma, a colon, a sentence,
 * a link, an invisible or direction-changing character) is not a name: the message
 * then greets nobody by name instead of repeating what was typed.
 */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u;
const MAX_LENGTH = 40;
const MAX_WORDS = 4;

export function greetingName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  // Control and format characters (line breaks, zero-width, right-to-left overrides) go first.
  const name = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!name || name.length > MAX_LENGTH || name.split(' ').length > MAX_WORDS || !NAME.test(name)) {
    return '';
  }

  return name;
}
