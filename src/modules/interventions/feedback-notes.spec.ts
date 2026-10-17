import { MAX_ISSUE_NOTES_LENGTH, notesAfterReview } from './feedback-notes';

describe('notesAfterReview', () => {
  it('with no problem reported the review text is stored as it always was', () => {
    expect(notesAfterReview(null, 'Parfait', false)).toBe('Parfait');
    expect(notesAfterReview('Ancien avis', 'Nouvel avis', false)).toBe('Nouvel avis');
    expect(notesAfterReview('Ancien avis', '', false)).toBe('');
    expect(notesAfterReview('Ancien avis', undefined, false)).toBe(undefined);
  });

  it('with a problem reported, an empty or missing text changes nothing', () => {
    expect(notesAfterReview('Fuite', '', true)).toBe(undefined);
    expect(notesAfterReview('Fuite', '   ', true)).toBe(undefined);
    expect(notesAfterReview('Fuite', undefined, true)).toBe(undefined);
    expect(notesAfterReview('Fuite', null, true)).toBe(undefined);
  });

  it('with a problem reported, a text is added after the report, not instead of it', () => {
    expect(notesAfterReview('Fuite', 'Sinon poli', true)).toBe('Fuite\n\nSinon poli');
  });

  it('the same text twice is not added twice', () => {
    expect(notesAfterReview('Fuite\n\nSinon poli', 'Sinon poli', true)).toBe(undefined);
  });

  it('a flag with no notes behind it just stores the text', () => {
    expect(notesAfterReview(null, 'Sinon poli', true)).toBe('Sinon poli');
    expect(notesAfterReview('  ', 'Sinon poli', true)).toBe('Sinon poli');
  });

  it('the notes never grow past the ceiling', () => {
    const long = 'x'.repeat(MAX_ISSUE_NOTES_LENGTH - 5);

    expect(notesAfterReview(long, 'abcdefghij', true)!.length).toBe(MAX_ISSUE_NOTES_LENGTH);
    expect(notesAfterReview('x'.repeat(MAX_ISSUE_NOTES_LENGTH), 'abc', true)).toBe(undefined);
  });
});
