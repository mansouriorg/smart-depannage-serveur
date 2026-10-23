import { ParsedSchema, SchemaField } from './prisma-schema';

/**
 * A row of any model, built from the schema alone (P1-09): every column has a value of its type,
 * and every relation is filled down to `depth` levels. It is the input the views are run on to read
 * the type of their answer (shape.ts); nothing here is stored or sent.
 */

/** What a variant of the row says about the columns that the views look at before they decide what to show. */
export interface Variant {
  /** The status of the job: the artisan's position is told only while they are on the way. */
  jobStatus: string;
  /** A draft invoice is not the customer's yet. */
  invoiceStatus: string;
}

const DEFAULT_DATE = new Date('2026-01-01T00:00:00.000Z');

function scalarValue(field: SchemaField): unknown {
  switch (field.type) {
    case 'String':
      return 'text';
    case 'Int':
    case 'Float':
    case 'Decimal':
      return 1;
    case 'Boolean':
      return false;
    case 'DateTime':
      return DEFAULT_DATE;
    case 'Json':
      return null;
    default:
      return 'text';
  }
}

export function buildRow(schema: ParsedSchema, modelName: string, depth: number, variant: Variant): Record<string, unknown> {
  const model = schema.models[modelName];
  const row: Record<string, unknown> = {};

  for (const field of model.fields) {
    const key = `${modelName}.${field.name}`;

    if (field.kind === 'model') {
      if (depth <= 0) continue;

      row[field.name] = field.list
        ? rowsOf(schema, field.type, depth - 1, variant)
        : buildRow(schema, field.type, depth - 1, variant);
      continue;
    }

    // The columns the views read before they decide: real values, so no view drops the row.
    if (key === 'Intervention.status') row[field.name] = variant.jobStatus;
    else if (key === 'Invoice.status') row[field.name] = variant.invoiceStatus;
    else if (key === 'Quote.status') row[field.name] = 'SENT';
    else if (key === 'InterventionEvent.type') row[field.name] = schema.enums.InterventionEventType.find((type) => type !== 'INTERNAL_NOTE_ADDED');
    else if (key === 'InterventionEvent.title') row[field.name] = 'Titre';
    else if (key === 'Message.deletedAt' || key === 'ComplaintMessage.deletedAt') row[field.name] = null;
    else if (key === 'ComplaintMessage.isInternal') row[field.name] = false;
    else if (field.kind === 'enum') row[field.name] = field.list ? [schema.enums[field.type][0]] : schema.enums[field.type][0];
    else row[field.name] = field.list ? [scalarValue(field)] : scalarValue(field);
  }

  return row;
}

/** The rows of a list relation: a message list has one message per chat, so that every chat is read. */
function rowsOf(schema: ParsedSchema, modelName: string, depth: number, variant: Variant): Array<Record<string, unknown>> {
  if (modelName === 'Message' && schema.enums.MessageAudience) {
    return schema.enums.MessageAudience.map((audience) => ({ ...buildRow(schema, modelName, depth, variant), audience }));
  }

  return [buildRow(schema, modelName, depth, variant)];
}

/** Two variants are enough: on the way with a sent invoice, and any other status with a draft one. */
export const VARIANTS: Variant[] = [
  { jobStatus: 'ARTISAN_ON_THE_WAY', invoiceStatus: 'SENT' },
  { jobStatus: 'CREATED', invoiceStatus: 'DRAFT' },
];
