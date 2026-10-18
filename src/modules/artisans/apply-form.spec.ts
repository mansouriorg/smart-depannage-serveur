import { parseApplication } from './apply-form';

const form = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Sami Ben Salah',
    email: 'sami@mail.tn',
    phone: '55 222 333',
    specialties: ['Plomberie'],
    yearsExperience: 4,
    zoneIds: [1, 5],
    ...over,
  });

function problems(raw: unknown): string[] {
  try {
    parseApplication(raw);
  } catch (error: any) {
    expect(error.getStatus()).toBe(400);

    // Nest answers { message: [...] } for a list of problems; the sandbox stand-in keeps the list as it is.
    const response = error.getResponse();
    const list = Array.isArray(response) ? response : Array.isArray(response?.message) ? response.message : null;

    return list ?? [error.message];
  }

  throw new Error('expected a refusal');
}

describe('reading the form of an application (P1-11)', () => {
  it('a complete form is read as it was written, with the optional fields left out when empty', () => {
    expect(parseApplication(form())).toEqual({
      name: 'Sami Ben Salah',
      email: 'sami@mail.tn',
      phone: '55 222 333',
      specialties: ['Plomberie'],
      yearsExperience: 4,
      zoneIds: [1, 5],
    });

    expect(parseApplication(form({ companyName: ' Sami SARL ', bio: '', insuranceNumber: null, specialty: 'Plomberie' }))).toEqual({
      name: 'Sami Ben Salah',
      email: 'sami@mail.tn',
      phone: '55 222 333',
      companyName: 'Sami SARL',
      specialty: 'Plomberie',
      specialties: ['Plomberie'],
      yearsExperience: 4,
      zoneIds: [1, 5],
    });
  });

  it('nothing, a text that is not JSON, and JSON that is not an object are refused', () => {
    expect(problems(undefined)).toEqual(['Le formulaire de candidature est vide.']);
    expect(problems('   ')).toEqual(['Le formulaire de candidature est vide.']);
    expect(problems({ name: 'a' })).toEqual(['Le formulaire de candidature est vide.']);
    expect(problems('{not json')).toEqual(['Le formulaire de candidature est illisible.']);
    expect(problems('[1,2]')).toEqual(['Le formulaire de candidature est illisible.']);
    expect(problems('"text"')).toEqual(['Le formulaire de candidature est illisible.']);
    expect(problems('null')).toEqual(['Le formulaire de candidature est illisible.']);
  });

  it('a form that is far too large is refused before it is read', () => {
    expect(problems(form({ bio: 'x'.repeat(30_000) }))).toEqual(['Le formulaire de candidature est trop volumineux.']);
  });

  it('the address of a document is no longer taken: it is refused by name, not silently ignored', () => {
    expect(problems(form({ identityDocumentUrl: 'https://evil.example/x' }))).toEqual(['Le champ « identityDocumentUrl » n’est pas accepté.']);
    expect(problems(form({ profilePhotoUrl: 'x', serviceAreas: ['Tunis'] }))).toHaveLength(2);
  });

  it('the name, the e-mail and the phone are required, and the e-mail looks like one', () => {
    expect(problems(form({ name: '  ' }))).toEqual(['Le nom est obligatoire.']);
    expect(problems(form({ email: undefined, phone: '' }))).toEqual(['L’e-mail est obligatoire.', 'Le téléphone est obligatoire.']);
    expect(problems(form({ email: 'sami@' }))).toEqual(['L’e-mail n’est pas valide.']);
    expect(problems(form({ email: 'sami mail@x.tn' }))).toEqual(['L’e-mail n’est pas valide.']);
    expect(problems(form({ name: 12 }))).toEqual(['Le nom doit être un texte.']);
  });

  it('long texts are refused: the form is public', () => {
    expect(problems(form({ name: 'x'.repeat(121) }))).toEqual(['Le nom dépasse 120 caractères.']);
    expect(problems(form({ bio: 'x'.repeat(2001) }))).toEqual(['La présentation dépasse 2000 caractères.']);
  });

  it('the years of experience are a whole number from 0 to 60', () => {
    for (const bad of [-1, 61, 2.5, '4', null, undefined]) {
      expect(problems(form({ yearsExperience: bad }))).toEqual(['Les années d’expérience doivent être un nombre entier entre 0 et 60.']);
    }

    expect(parseApplication(form({ yearsExperience: 0 })).yearsExperience).toBe(0);
    expect(parseApplication(form({ yearsExperience: 60 })).yearsExperience).toBe(60);
  });

  it('the trades are a list of texts (an empty list is read, the trade table refuses it with its own words)', () => {
    expect(parseApplication(form({ specialties: [] })).specialties).toEqual([]);
    expect(problems(form({ specialties: 'Plomberie' }))).toEqual(['Les métiers doivent être une liste de textes.']);
    expect(problems(form({ specialties: ['Plomberie', 3] }))).toEqual(['Les métiers doivent être une liste de textes.']);
    expect(problems(form({ specialties: Array.from({ length: 13 }, () => 'Plomberie') }))).toEqual(['Pas plus de 12 métiers.']);
  });

  it('a trade word is trimmed and cut to 60 characters (the trade table then refuses what is not a trade)', () => {
    expect(parseApplication(form({ specialties: ['  Plomberie  '] })).specialties).toEqual(['Plomberie']);
    expect(parseApplication(form({ specialties: ['x'.repeat(100)] })).specialties).toEqual(['x'.repeat(60)]);
  });

  it('at least one zone, only numbers of the list, no more than 24', () => {
    expect(problems(form({ zoneIds: [] }))).toEqual(['Choisissez au moins une zone d’intervention.']);
    expect(problems(form({ zoneIds: undefined }))).toEqual(['Choisissez au moins une zone d’intervention.']);
    expect(problems(form({ zoneIds: '1' }))).toEqual(['Choisissez au moins une zone d’intervention.']);
    expect(problems(form({ zoneIds: ['1'] }))).toEqual(['Les zones doivent être des numéros de la liste.']);
    expect(problems(form({ zoneIds: [0] }))).toEqual(['Les zones doivent être des numéros de la liste.']);
    expect(problems(form({ zoneIds: [1.5] }))).toEqual(['Les zones doivent être des numéros de la liste.']);
    expect(problems(form({ zoneIds: Array.from({ length: 25 }, (_, i) => i + 1) }))).toEqual(['Pas plus de 24 zones.']);
  });

  it('every problem is reported at once', () => {
    expect(problems(form({ name: '', yearsExperience: -1, zoneIds: [], extra: 1 })).length).toBe(4);
  });
});
