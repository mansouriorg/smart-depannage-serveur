/**
 * A small reader for prisma/schema.prisma (P1-09): the enums, and the models with their fields.
 * It reads text, not the Prisma client, so it runs without a database or a generated client.
 */

export type FieldKind = 'scalar' | 'enum' | 'model';

export interface SchemaField {
  name: string;
  /** The Prisma type name: String, Int, Role, User... */
  type: string;
  kind: FieldKind;
  list: boolean;
  optional: boolean;
}

export interface SchemaModel {
  name: string;
  fields: SchemaField[];
}

export interface ParsedSchema {
  enums: Record<string, string[]>;
  models: Record<string, SchemaModel>;
}

export const SCALAR_TYPES = ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Decimal', 'BigInt', 'Bytes'] as const;

/** The text without `// comments` (a `//` inside a quoted string stays). */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let quoted = false;

      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"' && line[i - 1] !== '\\') quoted = !quoted;
        if (!quoted && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
      }

      return line;
    })
    .join('\n');
}

export function parsePrismaSchema(text: string): ParsedSchema {
  const lines = withoutComments(text).split('\n');
  const enums: Record<string, string[]> = {};
  const rawModels: Record<string, Array<{ name: string; type: string; list: boolean; optional: boolean }>> = {};

  for (let i = 0; i < lines.length; i++) {
    const opening = /^\s*(model|enum)\s+(\w+)\s*\{\s*$/.exec(lines[i]);

    if (!opening) continue;

    const [, kind, name] = opening;
    const body: string[] = [];

    for (i = i + 1; i < lines.length && !/^\s*\}\s*$/.test(lines[i]); i++) {
      const line = lines[i].trim();

      if (line) body.push(line);
    }

    if (kind === 'enum') {
      enums[name] = body.filter((line) => !line.startsWith('@@')).map((line) => line.split(/\s+/)[0]);
      continue;
    }

    rawModels[name] = body
      .filter((line) => !line.startsWith('@@'))
      .map((line) => /^(\w+)\s+(\w+)(\[\])?(\?)?(?:\s|$)/.exec(line))
      .filter((found): found is RegExpExecArray => found !== null)
      .map((found) => ({ name: found[1], type: found[2], list: Boolean(found[3]), optional: Boolean(found[4]) }));
  }

  const models: Record<string, SchemaModel> = {};

  for (const [name, fields] of Object.entries(rawModels)) {
    models[name] = {
      name,
      fields: fields.map((field) => ({
        ...field,
        kind: (SCALAR_TYPES as readonly string[]).includes(field.type)
          ? 'scalar'
          : field.type in enums
            ? 'enum'
            : 'model',
      })),
    };
  }

  for (const model of Object.values(models)) {
    for (const field of model.fields) {
      if (field.kind === 'model' && !(field.type in models)) {
        throw new Error(`schema.prisma: ${model.name}.${field.name} has the type ${field.type}, which is neither a model, an enum nor a scalar`);
      }
    }
  }

  return { enums, models };
}
