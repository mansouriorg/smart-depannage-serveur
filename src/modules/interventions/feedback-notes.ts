/** Most characters the notes of a request may reach through the public tracking routes. */
export const MAX_ISSUE_NOTES_LENGTH = 4000;

/**
 * What the notes of a request become when its customer leaves a review.
 *
 * Nothing special while no problem was reported: the review's text is stored as
 * it always was. Once a problem was reported, the notes hold that report, and a
 * review (often sent by a form that posts every field, an empty one included)
 * must not erase it: an empty text changes nothing, a text is added after the
 * report. Undefined means "leave the notes as they are".
 */
export function notesAfterReview(
  existing: string | null | undefined,
  incoming: string | null | undefined,
  problemReported: boolean,
  max: number = MAX_ISSUE_NOTES_LENGTH,
): string | undefined {
  const reported = typeof existing === 'string' ? existing.trim() : '';

  if (!problemReported || !reported) {
    return incoming ?? undefined;
  }

  const text = typeof incoming === 'string' ? incoming.trim() : '';

  // Nothing new, the same text sent twice, or no room left: the report stays as it is.
  if (!text || reported.includes(text) || reported.length >= max) {
    return undefined;
  }

  return `${reported}\n\n${text}`.slice(0, max);
}
