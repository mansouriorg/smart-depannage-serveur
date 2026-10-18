import { BadRequestException } from '@nestjs/common';

import { TRADES, TRADE_LIST, TradeCode, tradesNamedBy, tradesOfText } from '../../common/trades/trades';

/**
 * What an artisan profile says about the trades of its owner (P1-10).
 *
 * A profile has three columns for this: `specialty` (the main one), `specialties` (all of them,
 * as words) and `serviceTypes` (all of them, as the service types a job can have). Only the
 * words were ever written, so the matching of artisans to jobs and the mission board each read
 * the words their own way (the board even handed them to the database as if they were service
 * types: "Plombier" made the request fail). Now the three are written together, from the same
 * table (`common/trades`), at every place a profile is made or changed.
 */

export interface TradeFields {
  /** The main trade: its label, or the text as it was typed when no trade is meant by it. */
  specialty: string;
  specialties: string[];
  serviceTypes: TradeCode[];
}

interface TradeInput {
  specialty?: string | null;
  specialties?: string[] | null;
}

export const TRADE_LABELS = TRADE_LIST.map((trade) => trade.label);

/** The texts of an input, trimmed, empty ones dropped. */
function textsOf(input: TradeInput): string[] {
  const all = [input.specialty, ...(input.specialties ?? [])];

  return all
    .filter((text): text is string => typeof text === 'string')
    .map((text) => text.trim())
    .filter(Boolean);
}

const given = (input: TradeInput) => input.specialty !== undefined || input.specialties !== undefined;

const unique = <T>(values: T[]) => values.filter((value, index) => values.indexOf(value) === index);

/**
 * The fields to write for the trades an artisan, an applicant or the back office gave, or null
 * when none of them was given (the columns stay as they are).
 *
 * Every text must name a trade ("Plombier", "Climatisation", "pose de portes"): a text that
 * names none is refused with the list to choose from, instead of becoming a specialty that no
 * job will ever match. At least one trade is needed whenever the field is sent, so an artisan
 * cannot empty the list to see every job.
 */
export function tradeFieldsFor(input: TradeInput): TradeFields | null {
  if (!given(input)) return null;

  const texts = textsOf(input);

  if (!texts.length) {
    throw new BadRequestException(`Indiquez au moins un métier parmi: ${TRADE_LABELS.join(', ')}.`);
  }

  const unknown = texts.filter((text) => tradesOfText(text).length === 0);

  if (unknown.length) {
    throw new BadRequestException(
      `Métier inconnu: ${unknown.map((text) => `« ${text} »`).join(', ')}. Choisissez parmi: ${TRADE_LABELS.join(', ')}.`,
    );
  }

  const trades = unique(texts.flatMap((text) => tradesOfText(text)));

  return {
    specialty: TRADES[trades[0]].label,
    specialties: trades.map((code) => TRADES[code].label),
    serviceTypes: trades,
  };
}

/**
 * The fields to write when a profile that already has trades is edited. Sending the list
 * (`specialties`) replaces it, as it says. Sending only the main one (`specialty`) puts that trade
 * first and keeps the others the profile already has: before the table, that edit changed the
 * main specialty and left the list alone, and an artisan who is a plumber and an electrician must
 * not lose a trade because the main one was changed. Null when neither was sent.
 */
export function tradeFieldsForEdit(
  input: TradeInput,
  stored: { specialties?: string[] | null; serviceTypes?: string[] | null },
): TradeFields | null {
  const fields = tradeFieldsFor(input);

  if (!fields || input.specialties !== undefined) return fields;

  const merged = lenientTradeFields({
    specialty: fields.specialty,
    specialties: [...fields.specialties, ...(stored.specialties ?? [])],
  })!;

  return {
    specialty: fields.specialty,
    specialties: merged.specialties,
    serviceTypes: unique([...fields.serviceTypes, ...merged.serviceTypes, ...((stored.serviceTypes ?? []) as TradeCode[])]),
  };
}

/**
 * The same fields for a text that is already stored and cannot be asked again (an application
 * that waited for its approval, a profile made before this table existed): a text that names no
 * trade stays as it was written and counts as "Autre", so the artisan still gets jobs of that
 * kind and the back office still reads what the applicant wrote.
 *
 * Null when there is no text at all.
 */
export function lenientTradeFields(input: TradeInput): TradeFields | null {
  const texts = textsOf(input);

  if (!texts.length) return null;

  const specialties: string[] = [];
  const serviceTypes: TradeCode[] = [];

  for (const text of texts) {
    const trades = tradesOfText(text);

    if (trades.length === 0) {
      specialties.push(text);
      serviceTypes.push('AUTRE');
      continue;
    }

    for (const code of trades) {
      specialties.push(TRADES[code].label);
      serviceTypes.push(code);
    }
  }

  const words = unique(specialties);

  return { specialty: words[0], specialties: words, serviceTypes: unique(serviceTypes) };
}

/**
 * The service types of an artisan, for the board of open jobs: the ones written on the profile
 * and the ones its words point to. Null when the profile names no trade at all (such an artisan
 * sees every job, as before); "Autre" when it has words that match nothing.
 */
export function tradesOfProfile(profile: {
  specialty?: string | null;
  specialties?: string[] | null;
  serviceTypes?: string[] | null;
}): TradeCode[] | null {
  const written = (profile.serviceTypes ?? []) as TradeCode[];
  const texts = textsOf(profile);
  const pointed = texts.flatMap((text) => tradesOfText(text));
  const trades = unique([...written, ...pointed]);

  if (trades.length) return trades;

  return texts.length ? ['AUTRE'] : null;
}

/**
 * What the migration does with one stored profile: the fields it should have, whether they differ
 * from what is stored (running it twice changes nothing the second time), the words that name no
 * trade, and the words that were only guessed (a keyword in a longer text, "Pose de portes" read
 * as a carpenter: worth a look before it is written). Null when the profile has no words at all.
 */
export function profileMigration(profile: {
  specialty: string | null;
  specialties: string[];
  serviceTypes: string[];
}): { fields: TradeFields; changed: boolean; unrecognized: string[]; inferred: string[] } | null {
  const fields = lenientTradeFields(profile);

  if (!fields) return null;

  // Trades already written stay (an admin may have set them by hand).
  const serviceTypes = unique([...(profile.serviceTypes as TradeCode[]), ...fields.serviceTypes]);
  const next = { ...fields, serviceTypes };

  const changed =
    profile.specialty !== next.specialty ||
    profile.specialties.join('|') !== next.specialties.join('|') ||
    [...profile.serviceTypes].sort().join('|') !== [...next.serviceTypes].sort().join('|');

  return {
    fields: next,
    changed,
    unrecognized: unique(textsOf(profile)).filter((text) => tradesOfText(text).length === 0),
    inferred: unique(textsOf(profile)).filter(
      (text) => tradesNamedBy(text).length === 0 && tradesOfText(text).length > 0,
    ),
  };
}
