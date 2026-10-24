import { ParsedSchema, SchemaField, SchemaModel } from './prisma-schema';

/**
 * The type of what a view really answers (P1-09).
 *
 * The views (src/common/views/views.ts) are the one place that decides what a customer, a visitor,
 * an artisan or the board may read. So the type of each of their answers is not written again by
 * hand: a job is built from the schema with every column and every relation filled, the real view
 * is run on it, and the type is read off what comes out. A column a view lets through is in the
 * type; a column it holds back is not.
 */

export type Node =
  | { k: 'prim'; t: string }
  | { k: 'null' }
  | { k: 'obj'; props: Map<string, { node: Node; optional: boolean }> }
  | { k: 'arr'; item: Node | null }
  | { k: 'union'; of: Node[] };

const SCALAR_TS: Record<string, string> = {
  String: 'string',
  Int: 'number',
  Float: 'number',
  Boolean: 'boolean',
  // A date travels as text in JSON.
  DateTime: 'string',
  Json: 'JsonValue',
  // A DECIMAL column leaves the API as a plain number (common/money/money-numbers), with at most three decimals.
  Decimal: 'number',
  BigInt: 'string',
  Bytes: 'string',
};

function fieldTs(field: SchemaField): string {
  const base = field.kind === 'enum' ? field.type : SCALAR_TS[field.type];
  const listed = field.list ? `${base}[]` : base;

  return field.optional && !field.list ? `${listed} | null` : listed;
}

function primNode(text: string): Node {
  const parts = text.split(' | ');

  return parts.length === 1 ? { k: 'prim', t: text } : { k: 'union', of: parts.map((part) => (part === 'null' ? { k: 'null' } : { k: 'prim', t: part })) };
}

/** What a JavaScript value is, for a key that the schema does not know (a computed one). */
function plainNode(value: unknown): Node {
  if (value === null || value === undefined) return { k: 'null' };
  if (Array.isArray(value)) return { k: 'arr', item: value.length ? value.map(plainNode).reduce(mergeNodes) : null };

  if (value instanceof Date) return { k: 'prim', t: 'string' };

  if (typeof value === 'object') {
    const props = new Map<string, { node: Node; optional: boolean }>();

    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      props.set(key, { node: plainNode(inner), optional: false });
    }

    return { k: 'obj', props };
  }

  return { k: 'prim', t: typeof value };
}

/**
 * A view may show the one element of a relation the row holds as a list: a job has `invoices`, and answers the invoice it shows as
 * `invoice` (the latest that is not cancelled, P2-07). That key is typed as the single, optional relation it stands for.
 */
function singleOfList(model: SchemaModel | null, key: string): SchemaField | undefined {
  const list = model?.fields.find((candidate) => candidate.kind === 'model' && candidate.list && candidate.name === `${key}s`);

  return list ? { name: key, type: list.type, kind: 'model', list: false, optional: true } : undefined;
}

/** The node of a row of `model`: schema types for its columns, and its relations, which a route may or may not include. */
function rowNode(row: Record<string, unknown>, model: SchemaModel | null, schema: ParsedSchema): Node {
  const props = new Map<string, { node: Node; optional: boolean }>();
  // A person is loaded with `select` by most routes (a name and a number): only their id is certain.
  const partial = model?.name === 'User';

  for (const [key, value] of Object.entries(row)) {
    const field = model?.fields.find((candidate) => candidate.name === key) ?? singleOfList(model, key);

    if (!field) {
      props.set(key, { node: plainNode(value), optional: false });
      continue;
    }

    if (field.kind !== 'model') {
      props.set(key, { node: primNode(fieldTs(field)), optional: partial && key !== 'id' });
      continue;
    }

    const related = schema.models[field.type];

    if (field.list) {
      props.set(key, { node: listNode(value, related, schema), optional: true });
    } else if (value === null || value === undefined) {
      props.set(key, { node: { k: 'null' }, optional: true });
    } else {
      const node = rowNode(value as Record<string, unknown>, related, schema);

      // A relation the schema marks optional (the artisan of a job not yet assigned, the invoice) may be null.
      props.set(key, { node: field.optional ? mergeNodes(node, { k: 'null' }) : node, optional: true });
    }
  }

  return { k: 'obj', props };
}

function listNode(value: unknown, model: SchemaModel, schema: ParsedSchema): Node {
  const rows = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];

  return { k: 'arr', item: rows.length ? rows.map((row) => rowNode(row, model, schema)).reduce(mergeNodes) : null };
}

/** The node of `row`, which is a row (or the answer built from a row) of the model `modelName`. */
export function nodeOfRow(row: unknown, modelName: string, schema: ParsedSchema): Node {
  return rowNode(row as Record<string, unknown>, schema.models[modelName], schema);
}

function flatten(node: Node): Node[] {
  return node.k === 'union' ? node.of.flatMap(flatten) : [node];
}

/** One node that fits both: a key one of them lacks becomes optional, and an object next to a null becomes "object | null". */
export function mergeNodes(a: Node, b: Node): Node {
  const parts = [...flatten(a), ...flatten(b)];
  const merged: Node[] = [];

  for (const part of parts) {
    const same = merged.findIndex((existing) => existing.k === part.k && (part.k !== 'prim' || (existing as { t: string }).t === part.t));

    if (same < 0) {
      merged.push(part);
      continue;
    }

    const existing = merged[same];

    if (existing.k === 'obj' && part.k === 'obj') {
      const props = new Map<string, { node: Node; optional: boolean }>();

      for (const [key, prop] of existing.props) {
        const other = part.props.get(key);

        props.set(key, other ? { node: mergeNodes(prop.node, other.node), optional: prop.optional || other.optional } : { node: prop.node, optional: true });
      }

      for (const [key, prop] of part.props) {
        if (!existing.props.has(key)) props.set(key, { node: prop.node, optional: true });
      }

      merged[same] = { k: 'obj', props };
    } else if (existing.k === 'arr' && part.k === 'arr') {
      merged[same] = { k: 'arr', item: existing.item && part.item ? mergeNodes(existing.item, part.item) : (existing.item ?? part.item) };
    }
  }

  const nulls = merged.filter((part) => part.k === 'null');
  const rest = merged.filter((part) => part.k !== 'null');
  const all = [...rest, ...nulls];

  return all.length === 1 ? all[0] : { k: 'union', of: all };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** TypeScript text for a node. `hoist(key, node)` may turn an object into a named type. */
export function renderNode(node: Node, indent = 0): string {
  const pad = '  '.repeat(indent);

  switch (node.k) {
    case 'prim':
      return node.t;
    case 'null':
      return 'null';
    case 'arr': {
      if (!node.item) return 'never[]';

      const inner = renderNode(node.item, indent);

      return node.item.k === 'union' ? `(${inner})[]` : `${inner}[]`;
    }
    case 'union':
      return node.of.map((part) => renderNode(part, indent)).join(' | ');
    case 'obj': {
      if (!node.props.size) return '{}';

      const rows = [...node.props].map(
        ([key, prop]) => `${pad}  ${IDENTIFIER.test(key) ? key : JSON.stringify(key)}${prop.optional ? '?' : ''}: ${renderNode(prop.node, indent + 1)};`,
      );

      return `{\n${rows.join('\n')}\n${pad}}`;
    }
  }
}
