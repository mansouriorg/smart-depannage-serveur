import { BadRequestException } from '@nestjs/common';

import { ApplyArtisanDto } from './dto/apply-artisan.dto';

/** The form is a few fields; anything larger is not a form. */
const MAX_FORM_CHARS = 20_000;

const MAX_ZONES = 24;
const MAX_TRADES = 12;

const FIELDS = new Set([
  'name',
  'email',
  'phone',
  'companyName',
  'companyNumber',
  'insuranceNumber',
  'specialty',
  'specialties',
  'yearsExperience',
  'bio',
  'zoneIds',
]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads the `data` field of the multipart application: a JSON object with the fields of
 * ApplyArtisanDto. A multipart request has no typed body, so the checks the global pipe does on
 * a JSON body are done here. Every problem is reported at once, in French, as a 400. A field that
 * is not in the form is refused: an old client that still sends the address of a document learns
 * that it is no longer taken, instead of believing it was.
 */
export function parseApplication(raw: unknown): ApplyArtisanDto {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BadRequestException('Le formulaire de candidature est vide.');
  }

  if (raw.length > MAX_FORM_CHARS) {
    throw new BadRequestException('Le formulaire de candidature est trop volumineux.');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('Le formulaire de candidature est illisible.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException('Le formulaire de candidature est illisible.');
  }

  const form = parsed as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(form)) {
    if (!FIELDS.has(key)) problems.push(`Le champ « ${key} » n’est pas accepté.`);
  }

  const text = (key: string, label: string, max: number, required: boolean): string | undefined => {
    const value = form[key];

    if (value === undefined || value === null || value === '') {
      if (required) problems.push(`${label} est obligatoire.`);

      return undefined;
    }

    if (typeof value !== 'string') {
      problems.push(`${label} doit être un texte.`);

      return undefined;
    }

    const trimmed = value.trim();

    if (!trimmed) {
      if (required) problems.push(`${label} est obligatoire.`);

      return undefined;
    }

    if (trimmed.length > max) {
      problems.push(`${label} dépasse ${max} caractères.`);

      return undefined;
    }

    return trimmed;
  };

  const name = text('name', 'Le nom', 120, true);
  const email = text('email', 'L’e-mail', 254, true);
  const phone = text('phone', 'Le téléphone', 30, true);

  if (email && !EMAIL.test(email)) problems.push('L’e-mail n’est pas valide.');

  const companyName = text('companyName', 'Le nom de l’entreprise', 160, false);
  const companyNumber = text('companyNumber', 'Le numéro de l’entreprise', 60, false);
  const insuranceNumber = text('insuranceNumber', 'Le numéro d’assurance', 60, false);
  const specialty = text('specialty', 'Le métier principal', 60, false);
  const bio = text('bio', 'La présentation', 2000, false);

  let specialties: string[] = [];

  if (!Array.isArray(form.specialties) || form.specialties.some((word) => typeof word !== 'string')) {
    problems.push('Les métiers doivent être une liste de textes.');
  } else if (form.specialties.length > MAX_TRADES) {
    problems.push(`Pas plus de ${MAX_TRADES} métiers.`);
  } else {
    specialties = (form.specialties as string[]).map((word) => word.trim().slice(0, 60));
  }

  const years = form.yearsExperience;

  if (typeof years !== 'number' || !Number.isInteger(years) || years < 0 || years > 60) {
    problems.push('Les années d’expérience doivent être un nombre entier entre 0 et 60.');
  }

  let zoneIds: number[] = [];

  if (!Array.isArray(form.zoneIds) || form.zoneIds.length < 1) {
    problems.push('Choisissez au moins une zone d’intervention.');
  } else if (form.zoneIds.length > MAX_ZONES) {
    problems.push(`Pas plus de ${MAX_ZONES} zones.`);
  } else if (form.zoneIds.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id < 1)) {
    problems.push('Les zones doivent être des numéros de la liste.');
  } else {
    zoneIds = form.zoneIds as number[];
  }

  if (problems.length) throw new BadRequestException(problems);

  return {
    name: name as string,
    email: email as string,
    phone: phone as string,
    ...(companyName ? { companyName } : {}),
    ...(companyNumber ? { companyNumber } : {}),
    ...(insuranceNumber ? { insuranceNumber } : {}),
    ...(specialty ? { specialty } : {}),
    specialties,
    yearsExperience: years as number,
    ...(bio ? { bio } : {}),
    zoneIds,
  };
}
