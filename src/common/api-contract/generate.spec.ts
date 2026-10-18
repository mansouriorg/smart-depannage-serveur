import * as fs from 'fs';
import * as path from 'path';

import { staffOnlyInterventionColumns } from '../views/intervention-columns';
import { readSource } from '../testing/source-scan';
import { COPIED_FILES, HEADER, contractDrift, generateContract } from './generate';
import { parsePrismaSchema } from './prisma-schema';
import { Node, mergeNodes, nodeOfRow, renderNode } from './shape';

const ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** The fields of a generated type, by name. `type` is the text between `export type Name = {` and the closing brace. */
function typeBody(source: string, name: string): string {
  const start = source.indexOf(`export type ${name} = {`);

  if (start < 0) return '';

  return source.slice(start, source.indexOf('\n};\n', start) + 4);
}

const keysIn = (body: string) => [...body.matchAll(/^\s+([A-Za-z_$][A-Za-z0-9_$]*)\??:/gm)].map((found) => found[1]);

describe('the Prisma schema reader (P1-09)', () => {
  const text = `
    // a comment
    enum Color {
      RED
      GREEN @map("green")
      @@map("colors")
    }

    model Parent {
      id       Int      @id @default(autoincrement())
      name     String   // the name
      note     String?
      tags     String[]
      color    Color    @default(RED)
      kids     Child[]
      @@index([name])
    }

    model Child {
      id       Int     @id
      parentId Int
      parent   Parent  @relation(fields: [parentId], references: [id])
      when     DateTime? @default(now())
      label    String  @default("a // b")
    }
  `;

  it('reads enums, scalars, lists, optional columns and relations', () => {
    const schema = parsePrismaSchema(text);

    expect(schema.enums.Color).toEqual(['RED', 'GREEN']);
    expect(schema.models.Parent.fields.map((field) => `${field.name}:${field.kind}${field.list ? '[]' : ''}${field.optional ? '?' : ''}`)).toEqual([
      'id:scalar',
      'name:scalar',
      'note:scalar?',
      'tags:scalar[]',
      'color:enum',
      'kids:model[]',
    ]);
    expect(schema.models.Child.fields.find((field) => field.name === 'parent')).toMatchObject({ kind: 'model', type: 'Parent' });
    expect(schema.models.Child.fields.find((field) => field.name === 'label')).toBeDefined();
  });

  it('refuses a type it does not know, instead of guessing', () => {
    expect(() => parsePrismaSchema('model A {\n  b Unknown\n}\n')).toThrow(/Unknown/);
  });

  it('reads the real schema: every model has an id, and Intervention has its relations', () => {
    const schema = parsePrismaSchema(read('prisma/schema.prisma'));

    expect(Object.keys(schema.models).length).toBeGreaterThan(20);
    expect(schema.models.Intervention.fields.some((field) => field.name === 'trackingToken')).toBe(true);
    expect(schema.models.Intervention.fields.find((field) => field.name === 'payments')).toMatchObject({ kind: 'model', list: true });
    expect(schema.enums.MessageAudience).toContain('INTERNAL_ADMIN');
  });
});

describe('the type of what a view answers (P1-09)', () => {
  const schema = parsePrismaSchema(`
    enum Level {
      LOW
      HIGH
    }
    model Job {
      id     Int @id
      level  Level
      note   String?
      owner  User  @relation(fields: [ownerId], references: [id])
      ownerId Int
      helper User? @relation("Helper", fields: [helperId], references: [id])
      helperId Int?
      parts  Part[]
    }
    model User {
      id    Int @id
      name  String
      email String
    }
    model Part {
      id Int @id
      label String
    }
  `);
  const person = { id: 1, name: 'a', email: 'b' };
  const row = { id: 1, level: 'LOW', note: null, owner: person, helper: person, parts: [{ id: 1, label: 'x' }] };

  it('a column has the type of the schema, a relation is optional, an optional relation may be null', () => {
    const text = renderNode(nodeOfRow(row, 'Job', schema));

    expect(text).toContain('id: number;');
    expect(text).toContain('level: Level;');
    expect(text).toContain('note: string | null;');
    expect(text).toContain('owner?: {');
    expect(text).toContain('helper?: {');
    expect(text).toMatch(/helper\?: \{[\s\S]*?\} \| null;/);
    expect(text).toContain('parts?: {');
  });

  it('only what the view lets through is in the type', () => {
    const view = (job: any) => ({ id: job.id, owner: { name: job.owner.name } });
    const text = renderNode(nodeOfRow(view(row), 'Job', schema));

    expect(text).toContain('name?: string;');
    expect(text).not.toContain('email');
    expect(text).not.toContain('note');
    expect(text).not.toContain('level');
  });

  it('an empty list has no element type, a key one answer lacks is optional, a null beside an object makes "object | null"', () => {
    expect(renderNode(nodeOfRow({ id: 1, parts: [] }, 'Job', schema))).toContain('parts?: never[];');

    const merged = mergeNodes(nodeOfRow({ id: 1, owner: person }, 'Job', schema), nodeOfRow({ id: 1, note: null }, 'Job', schema));
    const text = renderNode(merged);

    expect(text).toContain('note?: string | null;');
    expect(text).toContain('owner?: {');

    const nulled: Node = mergeNodes(nodeOfRow({ id: 1, helper: null }, 'Job', schema), nodeOfRow({ id: 1, helper: person }, 'Job', schema));

    expect(renderNode(nulled)).toMatch(/helper\?: \{[\s\S]*?\} \| null;/);
  });

  it('a person is partial (a route loads a name and a number), the rest of a row is whole', () => {
    const text = renderNode(nodeOfRow(row, 'Job', schema));

    expect(text).toMatch(/owner\?: \{\s+id: number;\s+name\?: string;\s+email\?: string;\s+\}/);
    expect(text).toMatch(/parts\?: \{\s+id: number;\s+label: string;\s+\}\[\];/);
  });

  it('a computed key that the schema does not know gets the type of its value', () => {
    const text = renderNode(nodeOfRow({ id: 1, read: true, distanceKm: 2.5, label: 'x', sender: { id: 1, name: 'n' } }, 'Job', schema));

    expect(text).toContain('read: boolean;');
    expect(text).toContain('distanceKm: number;');
    expect(text).toContain('label: string;');
    expect(text).toContain('sender: {');
  });
});

describe('the files that come from the server (P1-09)', () => {
  const files = generateContract(read);
  const views = files['views.ts'];

  it('the generated set is the same every time, and every file says where it comes from', () => {
    expect(generateContract(read)).toEqual(files);
    expect(Object.keys(files).sort()).toEqual(['enums.ts', 'envelope.ts', 'index.ts', 'intervention-status.ts', 'views.ts']);

    for (const text of Object.values(files)) {
      expect(text.startsWith(HEADER)).toBe(true);
    }
  });

  it('the page type and the status table are copied as they are', () => {
    for (const copied of COPIED_FILES) {
      expect(files[copied.to]).toBe(`${HEADER}${read(copied.from)}`);
    }

    expect(files['envelope.ts']).toContain('export interface Paginated<T>');
    expect(files['intervention-status.ts']).toContain('export const CANONICAL_STATUSES');
  });

  it('the copied files import nothing, so they compile wherever they are copied', () => {
    for (const copied of COPIED_FILES) {
      expect(readSource(copied.from.replace(/^src\//, ''))).not.toMatch(/^\s*import\s/m);
    }
  });

  it('a date is text, a Json column is JsonValue, numbers and booleans stay what they are (checked here, without the shared package)', () => {
    expect(views).toContain('createdAt: string;');
    expect(views).toContain('materialUsed: JsonValue | null;');
    expect(views).toContain('latitude: number | null;');
    expect(views).toContain('hasIssue: boolean;');
    expect(views).toContain('urgency: UrgencyLevel;');
    expect(views).not.toMatch(/:\s*Date\b/);
    expect(views).not.toMatch(/\bunknown\b/);
  });

  it('every enum of the schema is a union type with its list of values', () => {
    const schema = parsePrismaSchema(read('prisma/schema.prisma'));

    for (const [name, values] of Object.entries(schema.enums)) {
      expect(files['enums.ts']).toContain(`export type ${name} = (typeof ${name}Values)[number];`);
      expect(files['enums.ts']).toContain(`'${values[0]}'`);
    }
  });

  it('the five jobs a reader may receive are there', () => {
    for (const name of ['ClientIntervention', 'TrackingIntervention', 'ArtisanIntervention', 'BoardIntervention', 'RoomIntervention']) {
      expect(typeBody(views, name)).not.toBe('');
    }
  });

  it('no type of a job holds a column that is for the back office', () => {
    const forbidden = [
      ...staffOnlyInterventionColumns(),
      'adminNote',
      'adminNotes',
      'moderationReason',
      'moderatedById',
      'providerPaymentId',
      'failureReason',
      'createdById',
      'emailedTo',
      'cancelReason',
      'storagePath',
      'storageProvider',
      'checksum',
      'readByUserIds',
      'actorId',
      'recipient',
      'deliveries',
      'passwordHash',
    ];

    expect(forbidden.length).toBeGreaterThan(10);
    expect(forbidden.filter((key) => keysIn(views).includes(key))).toEqual([]);
  });

  it('what each reader receives of the customer and of the artisan', () => {
    const client = keysIn(typeBody(views, 'ClientIntervention'));
    const tracking = keysIn(typeBody(views, 'TrackingIntervention'));
    const board = keysIn(typeBody(views, 'BoardIntervention'));
    const room = keysIn(typeBody(views, 'RoomIntervention'));
    const artisan = keysIn(typeBody(views, 'ArtisanIntervention'));

    expect(client).toContain('artisan');
    expect(client).toContain('contactPhone');
    expect(client).not.toContain('beforePhotoLat');

    expect(tracking).not.toContain('client');
    expect(tracking).not.toContain('clientId');
    expect(tracking).not.toContain('artisanId');

    // The board knows the customer by a first name, and nothing to reach them by (until the job is theirs).
    for (const column of ['contactName', 'contactPhone', 'contactEmail', 'accessInstructions', 'apartmentCode', 'artisan', 'clientId']) {
      expect(board).not.toContain(column);
    }

    expect(keysIn(typeBody(views, 'BoardInterventionClient'))).toEqual(['name']);

    for (const column of ['client', 'artisan', 'description', 'address', 'contactPhone']) {
      expect(room).not.toContain(column);
    }

    expect(artisan).toContain('client');
    expect(artisan).not.toContain('complaints');
    expect(keysIn(typeBody(views, 'ArtisanInterventionClient'))).toEqual(['id', 'name', 'phone', 'email']);
  });

  it('the artisan\'s position is there only while they are on the way', () => {
    const artisan = typeBody(views, 'ClientInterventionArtisan');

    expect(artisan).toContain('latitude?: number | null;');
    expect(artisan).toContain('longitude?: number | null;');
    expect(typeBody(views, 'TrackingInterventionArtisan')).not.toContain('id:');
  });

  it('a draft invoice is not the customer\'s: the invoice may be null', () => {
    expect(typeBody(views, 'ClientIntervention')).toContain('invoice?: ClientInterventionInvoice | null;');
    expect(typeBody(views, 'BoardIntervention')).toContain('invoice?: null;');
  });

  it('no `any` anywhere, and the file is plain TypeScript with one import', () => {
    expect(views).not.toMatch(/\bany\b/);
    expect(views.match(/^import /gm)?.length).toBe(1);
  });

  it('the shared package, when it sits next to the server, holds exactly these files', () => {
    const folder = path.resolve(ROOT, '../smart-depannage-shared/src/generated');

    if (!fs.existsSync(folder)) return;

    const onDisk: Record<string, string> = {};

    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile()) onDisk[entry.name] = fs.readFileSync(path.join(folder, entry.name), 'utf8');
    }

    expect(contractDrift(files, onDisk)).toEqual([]);
  });

  it('contractDrift names a missing file, an out of date one and a left over one, and ignores line endings', () => {
    const generated = { 'a.ts': 'one\ntwo\n', 'b.ts': 'b\n', 'c.ts': 'c\n' };

    expect(contractDrift(generated, { ...generated })).toEqual([]);
    expect(contractDrift(generated, { 'a.ts': 'one\r\ntwo\r\n', 'b.ts': 'b\n', 'c.ts': 'c\n' })).toEqual([]);
    expect(contractDrift(generated, { 'a.ts': 'one\ntwo\n', 'b.ts': 'b!\n', 'c.ts': 'c\n', 'old.ts': 'x' })).toEqual([
      'b.ts: out of date',
      'old.ts: left over (nothing generates it any more)',
    ]);
    expect(contractDrift(generated, { 'a.ts': 'one\ntwo\n' })).toEqual(['b.ts: missing', 'c.ts: missing']);
    expect(contractDrift({}, {})).toEqual([]);
  });
});
