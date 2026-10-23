import { MemoryPrisma, parseSchema } from './memory-prisma';

const SCHEMA = `
enum Kind {
  A
  B
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  kind      Kind     @default(A)
  active    Boolean  @default(true)
  posts     Post[]   @relation("Authored")
  reviewed  Post[]   @relation("Reviewed")
  profile   Profile?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Profile {
  id     Int     @id @default(autoincrement())
  userId Int     @unique
  user   User    @relation(fields: [userId], references: [id])
  bio    String? // a comment on the line
}

model Post {
  id         Int       @id @default(autoincrement())
  title      String
  score      Int       @default(0)
  tags       String[]  @default([])
  publishedAt DateTime?
  authorId   Int
  author     User      @relation("Authored", fields: [authorId], references: [id])
  reviewerId Int?
  reviewer   User?     @relation("Reviewed", fields: [reviewerId], references: [id])
  comments   Comment[]
}

model Comment {
  id     Int    @id @default(autoincrement())
  postId Int
  post   Post   @relation(fields: [postId], references: [id])
  text   String

  @@unique([postId, text])
}
`;

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

function world() {
  const memory = new MemoryPrisma(SCHEMA);
  const db = memory.client();

  return { memory, db };
}

async function populated() {
  const { memory, db } = world();
  const ann = await db.user.create({ data: { email: 'ann@x.tn', name: 'Ann' } });
  const bob = await db.user.create({ data: { email: 'bob@x.tn', name: null, kind: 'B' } });
  const first = await db.post.create({ data: { title: 'Plomberie', score: 5, authorId: ann.id, reviewerId: bob.id, tags: ['a', 'b'] } });
  const second = await db.post.create({ data: { title: 'Électricité', score: 9, authorId: ann.id } });
  const third = await db.post.create({ data: { title: 'plomberie bis', score: 1, authorId: bob.id, publishedAt: new Date('2026-01-02T00:00:00Z') } });

  await db.comment.create({ data: { postId: first.id, text: 'bravo' } });
  await db.comment.create({ data: { postId: first.id, text: 'merci' } });
  await db.comment.create({ data: { postId: third.id, text: 'bravo' } });

  return { memory, db, ann, bob, first, second, third };
}

describe('MemoryPrisma: reading the schema', () => {
  it('reads models, fields, relations, enums and compound uniques, and ignores comments', () => {
    const { models, enums } = parseSchema(SCHEMA);

    expect([...models.keys()]).toEqual(['User', 'Profile', 'Post', 'Comment']);
    expect(enums.get('Kind')).toEqual(['A', 'B']);
    expect(models.get('Post')?.fields.get('author')?.kind).toBe('relation');
    expect(models.get('Post')?.fields.get('author')?.fkFields).toEqual(['authorId']);
    expect(models.get('Post')?.fields.get('reviewer')?.relationName).toBe('Reviewed');
    expect(models.get('Post')?.fields.get('tags')?.list).toBe(true);
    expect(models.get('Profile')?.fields.get('bio')?.optional).toBe(true);
    expect(JSON.stringify(models.get('Comment')?.uniques.slice().sort())).toBe('[["id"],["postId","text"]]');
  });

  it('refuses a relation to something that is not a model', () => {
    expect(() => parseSchema('model A {\n id Int @id\n b Missing\n}')).toThrow('not a model');
  });

  it('the real schema is read, and every relation of it finds its other side', () => {
    const real = new MemoryPrisma();

    expect(real.models.size).toBeGreaterThan(40);
    expect(real.models.has('Intervention')).toBe(true);
    expect(() => real.verifySchema()).not.toThrow();
  });
});

describe('MemoryPrisma: creating', () => {
  it('numbers rows, applies the defaults, and gives a copy that can be edited without changing the table', async () => {
    const { memory, db } = world();
    const user = await db.user.create({ data: { email: 'a@x.tn' } });

    expect(user).toMatchObject({ id: 1, email: 'a@x.tn', name: null, kind: 'A', active: true });
    expect(user.createdAt instanceof Date).toBe(true);
    expect(user).not.toHaveProperty('posts');
    user.email = 'changed';
    expect(memory.rows('user')[0].email).toBe('a@x.tn');
  });

  it('a unique column that is taken is a P2002, and null never collides', async () => {
    const { db } = world();

    await db.user.create({ data: { email: 'a@x.tn' } });

    const error = await failure(db.user.create({ data: { email: 'a@x.tn' } }));

    expect(error.code).toBe('P2002');
    expect(error.meta.target).toEqual(['email']);

    await db.profile.create({ data: { user: { create: { email: 'p@x.tn' } }, bio: null } });
    await db.user.create({ data: { email: 'q@x.tn', name: null } });
    await db.user.create({ data: { email: 'r@x.tn', name: null } });
  });

  it('a compound unique is checked too', async () => {
    const { db, first } = await populated();

    expect((await failure(db.comment.create({ data: { postId: first.id, text: 'bravo' } }))).code).toBe('P2002');
  });

  it('a required field that is missing, a field that does not exist and a value of the wrong type are errors, not silent', async () => {
    const { db } = world();

    expect((await failure(db.user.create({ data: { name: 'x' } }))).message).toContain('User.email is required');
    expect((await failure(db.user.create({ data: { email: 'a@x.tn', nope: 1 } }))).message).toContain('no field "nope"');
    expect((await failure(db.user.create({ data: { email: 5 } }))).message).toContain('expects a string');
    expect((await failure(db.post.create({ data: { title: 'x', score: 1.5, authorId: 1 } }))).message).toContain('expects an integer');
  });

  it('ids keep counting after a row with an id of its own', async () => {
    const { db } = world();

    await db.user.create({ data: { id: 10, email: 'a@x.tn' } });

    expect((await db.user.create({ data: { email: 'b@x.tn' } })).id).toBe(11);
  });
});

describe('MemoryPrisma: where', () => {
  it('equals, in, notIn, not, null, comparisons on numbers and dates, and text filters with and without case', async () => {
    const { db, first, second, third } = await populated();
    const ids = async (where: any) => (await db.post.findMany({ where, orderBy: { id: 'asc' } })).map((row: any) => row.id);

    expect(await ids({ score: 5 })).toEqual([first.id]);
    expect(await ids({ score: { in: [1, 9] } })).toEqual([second.id, third.id]);
    expect(await ids({ score: { notIn: [1, 9] } })).toEqual([first.id]);
    expect(await ids({ score: { not: 5 } })).toEqual([second.id, third.id]);
    expect(await ids({ score: { not: { gt: 4 } } })).toEqual([third.id]);
    expect(await ids({ reviewerId: null })).toEqual([second.id, third.id]);
    expect(await ids({ reviewerId: { not: null } })).toEqual([first.id]);
    expect(await ids({ score: { gt: 1, lte: 9 } })).toEqual([first.id, second.id]);
    expect(await ids({ publishedAt: { gte: new Date('2026-01-01T00:00:00Z') } })).toEqual([third.id]);
    expect(await ids({ publishedAt: new Date('2026-01-02T00:00:00Z') })).toEqual([third.id]);
    expect(await ids({ title: { contains: 'plomb' } })).toEqual([third.id]);
    expect(await ids({ title: { contains: 'plomb', mode: 'insensitive' } })).toEqual([first.id, third.id]);
    expect(await ids({ title: { startsWith: 'Élec' } })).toEqual([second.id]);
    expect(await ids({ title: { endsWith: 'bis' } })).toEqual([third.id]);
    expect(await ids({ tags: { has: 'b' } })).toEqual([first.id]);
    expect(await ids({ tags: { isEmpty: true } })).toEqual([second.id, third.id]);
    expect(await ids({ undefinedFilter: undefined })).toEqual([first.id, second.id, third.id]);
  });

  it('AND, OR and NOT', async () => {
    const { db, first, second, third } = await populated();
    const ids = async (where: any) => (await db.post.findMany({ where, orderBy: { id: 'asc' } })).map((row: any) => row.id);

    expect(await ids({ OR: [{ score: 5 }, { score: 1 }] })).toEqual([first.id, third.id]);
    expect(await ids({ AND: [{ score: { gt: 1 } }, { score: { lt: 9 } }] })).toEqual([first.id]);
    expect(await ids({ NOT: { score: 5 } })).toEqual([second.id, third.id]);
    expect(await ids({ NOT: [{ score: 5 }, { score: 9 }] })).toEqual([third.id]);
    expect(await ids({ OR: [] })).toEqual([]);
  });

  it('a field or an operator it does not know is an error: no filter is ever ignored', async () => {
    const { db } = await populated();

    expect((await failure(db.post.findMany({ where: { nothing: 1 } }))).message).toContain('no field "nothing"');
    expect((await failure(db.post.findMany({ where: { score: { near: 1 } } }))).message).toContain('unknown filter near');
    expect((await failure(db.post.findMany({ where: { comments: { several: {} } } }))).message).toContain('unknown relation filter');
  });

  it('through a relation: to one directly, with is / isNot, and to many with some / every / none, two levels deep', async () => {
    const { db, ann, bob, first, second, third } = await populated();
    const ids = async (where: any) => (await db.post.findMany({ where, orderBy: { id: 'asc' } })).map((row: any) => row.id);

    expect(await ids({ author: { email: 'ann@x.tn' } })).toEqual([first.id, second.id]);
    expect(await ids({ author: { is: { id: bob.id } } })).toEqual([third.id]);
    expect(await ids({ author: { isNot: { id: bob.id } } })).toEqual([first.id, second.id]);
    expect(await ids({ reviewer: null })).toEqual([second.id, third.id]);
    expect(await ids({ reviewer: { isNot: null } })).toEqual([first.id]);
    expect(await ids({ comments: { some: { text: 'bravo' } } })).toEqual([first.id, third.id]);
    expect(await ids({ comments: { every: { text: 'bravo' } } })).toEqual([second.id, third.id]);
    expect(await ids({ comments: { none: {} } })).toEqual([second.id]);
    expect(await ids({ author: { reviewed: { some: { id: first.id } } } })).toEqual([third.id]);
    expect(await ids({ reviewer: { posts: { some: { id: third.id } } } })).toEqual([first.id]);
    expect((await db.user.findMany({ where: { posts: { some: { comments: { some: { text: 'merci' } } } } } })).map((row: any) => row.id)).toEqual([ann.id]);
  });

  it('a compound unique key in a where', async () => {
    const { db, first } = await populated();

    expect((await db.comment.findUnique({ where: { postId_text: { postId: first.id, text: 'merci' } } })).text).toBe('merci');
    expect(await db.comment.findUnique({ where: { postId_text: { postId: first.id, text: 'rien' } } })).toBeNull();
  });
});

describe('MemoryPrisma: what a read gives back', () => {
  it('include loads relations, with a where, an order and a limit of their own; select keeps only what it names', async () => {
    const { db, first } = await populated();
    const post = await db.post.findUnique({
      where: { id: first.id },
      include: { author: true, comments: { where: { text: { not: 'merci' } }, orderBy: { id: 'desc' }, take: 5 }, reviewer: { select: { email: true } } },
    });

    expect(post.author.email).toBe('ann@x.tn');
    expect(post.author).not.toHaveProperty('posts');
    expect(post.comments.map((comment: any) => comment.text)).toEqual(['bravo']);
    expect(post.reviewer).toEqual({ email: 'bob@x.tn' });

    const slim = await db.post.findUnique({ where: { id: first.id }, select: { title: true, author: { select: { name: true } } } });

    expect(slim).toEqual({ title: 'Plomberie', author: { name: 'Ann' } });
  });

  it('a to-one relation that points at nothing is null, a to-many with nothing is an empty list', async () => {
    const { db, second } = await populated();
    const post = await db.post.findUnique({ where: { id: second.id }, include: { reviewer: true, comments: true } });

    expect(post.reviewer).toBeNull();
    expect(post.comments).toEqual([]);
  });

  it('the other side of a one-to-one, by the key on the other table', async () => {
    const { db } = world();
    const user = await db.user.create({ data: { email: 'a@x.tn', profile: { create: { bio: 'hello' } } } });

    expect((await db.user.findUnique({ where: { id: user.id }, include: { profile: true } })).profile.bio).toBe('hello');
    expect((await db.profile.findFirst({ where: { user: { email: 'a@x.tn' } } })).bio).toBe('hello');
  });

  it('_count', async () => {
    const { db, first } = await populated();

    expect((await db.post.findUnique({ where: { id: first.id }, select: { _count: { select: { comments: true } } } }))._count).toEqual({ comments: 2 });
    expect((await db.post.findUnique({ where: { id: first.id }, include: { _count: true } }))._count).toEqual({ comments: 2 });
  });

  it('orderBy: ascending, descending, several keys, null last when ascending and first when descending, and by a field of a relation', async () => {
    const { db, first, second, third } = await populated();
    const ids = async (args: any) => (await db.post.findMany(args)).map((row: any) => row.id);

    expect(await ids({ orderBy: { score: 'asc' } })).toEqual([third.id, first.id, second.id]);
    expect(await ids({ orderBy: { score: 'desc' } })).toEqual([second.id, first.id, third.id]);
    expect(await ids({ orderBy: [{ authorId: 'asc' }, { score: 'desc' }] })).toEqual([second.id, first.id, third.id]);
    expect(await ids({ orderBy: { publishedAt: 'asc' } })).toEqual([third.id, first.id, second.id]);
    expect(await ids({ orderBy: { publishedAt: 'desc' } })).toEqual([first.id, second.id, third.id]);
    expect(await ids({ orderBy: { author: { email: 'desc' } } })).toEqual([third.id, first.id, second.id]);
  });

  it('take, skip and distinct', async () => {
    const { db, first, second, third } = await populated();

    expect((await db.post.findMany({ orderBy: { id: 'asc' }, skip: 1, take: 1 })).map((row: any) => row.id)).toEqual([second.id]);
    expect((await db.post.findMany({ orderBy: { id: 'asc' }, distinct: ['authorId'] })).map((row: any) => row.id)).toEqual([first.id, third.id]);
  });

  it('findUnique / findFirst give null, the OrThrow forms give P2025', async () => {
    const { db } = await populated();

    expect(await db.post.findUnique({ where: { id: 99 } })).toBeNull();
    expect(await db.post.findFirst({ where: { score: 99 } })).toBeNull();
    expect((await failure(db.post.findUniqueOrThrow({ where: { id: 99 } }))).code).toBe('P2025');
    expect((await failure(db.post.findFirstOrThrow({ where: { id: 99 } }))).code).toBe('P2025');
  });

  it('count, aggregate and groupBy', async () => {
    const { db } = await populated();

    expect(await db.post.count()).toBe(3);
    expect(await db.post.count({ where: { score: { gt: 1 } } })).toBe(2);
    expect(await db.post.count({ select: { _all: true, reviewerId: true } })).toEqual({ _all: 3, reviewerId: 1 });

    const totals = await db.post.aggregate({ where: { authorId: 1 }, _sum: { score: true }, _avg: { score: true }, _max: { score: true }, _min: { score: true }, _count: { _all: true } });

    expect(totals).toEqual({ _sum: { score: 14 }, _avg: { score: 7 }, _max: { score: 9 }, _min: { score: 5 }, _count: { _all: 2 } });

    const grouped = await db.post.groupBy({ by: ['authorId'], _count: { _all: true }, _sum: { score: true } });

    expect(grouped).toEqual([
      { authorId: 1, _count: { _all: 2 }, _sum: { score: 14 } },
      { authorId: 2, _count: { _all: 1 }, _sum: { score: 1 } },
    ]);
  });
});

describe('MemoryPrisma: changing', () => {
  it('update sets, increments, decrements, clears, and stamps @updatedAt; a miss is P2025', async () => {
    const { memory, db, first } = await populated();
    const user = await db.user.findUnique({ where: { id: 1 } });

    memory.setClock(() => new Date('2030-01-01T00:00:00Z'));

    const changed = await db.user.update({ where: { id: 1 }, data: { name: null, active: false } });

    expect(changed).toMatchObject({ name: null, active: false });
    expect(changed.updatedAt.getTime()).toBe(new Date('2030-01-01T00:00:00Z').getTime());
    expect(user.updatedAt.getTime()).toBeLessThan(changed.updatedAt.getTime());

    expect((await db.post.update({ where: { id: first.id }, data: { score: { increment: 2 } } })).score).toBe(7);
    expect((await db.post.update({ where: { id: first.id }, data: { score: { decrement: 3 } } })).score).toBe(4);
    expect((await db.post.update({ where: { id: first.id }, data: { score: { set: 1 } } })).score).toBe(1);
    expect((await db.post.update({ where: { id: first.id }, data: { tags: { push: 'c' } } })).tags).toEqual(['a', 'b', 'c']);
    expect((await failure(db.post.update({ where: { id: 99 }, data: { score: 1 } }))).code).toBe('P2025');
    expect((await failure(db.user.update({ where: { id: 1 }, data: { email: null } }))).message).toContain('cannot be null');
  });

  it('an update that would break a unique column is a P2002 and leaves the row as it was', async () => {
    const { db } = await populated();

    expect((await failure(db.user.update({ where: { id: 2 }, data: { email: 'ann@x.tn' } }))).code).toBe('P2002');
    expect((await db.user.findUnique({ where: { id: 2 } })).email).toBe('bob@x.tn');
  });

  it('updateMany counts what it changed and only changes what the where selects', async () => {
    const { db } = await populated();

    expect(await db.post.updateMany({ where: { authorId: 1 }, data: { score: 0 } })).toEqual({ count: 2 });
    expect(await db.post.updateMany({ where: { id: 99 }, data: { score: 0 } })).toEqual({ count: 0 });
    expect((await db.post.findMany({ orderBy: { id: 'asc' } })).map((row: any) => row.score)).toEqual([0, 0, 1]);
  });

  it('a conditional update is all-or-nothing in one step: the second of two identical claims finds nothing to change', async () => {
    const { db, first } = await populated();
    const claim = () => db.post.updateMany({ where: { id: first.id, reviewerId: 2 }, data: { reviewerId: null } });
    const [a, b] = await Promise.all([claim(), claim()]);

    expect([a.count, b.count].sort()).toEqual([0, 1]);
  });

  it('upsert creates or updates; delete returns the row, deleteMany counts', async () => {
    const { db } = await populated();

    expect((await db.user.upsert({ where: { email: 'new@x.tn' }, create: { email: 'new@x.tn' }, update: { name: 'x' } })).name).toBeNull();
    expect((await db.user.upsert({ where: { email: 'new@x.tn' }, create: { email: 'new@x.tn' }, update: { name: 'x' } })).name).toBe('x');
    expect((await db.user.delete({ where: { email: 'new@x.tn' } })).email).toBe('new@x.tn');
    expect((await failure(db.user.delete({ where: { email: 'new@x.tn' } }))).code).toBe('P2025');
    expect(await db.comment.deleteMany({ where: { text: 'bravo' } })).toEqual({ count: 2 });
    expect(await db.comment.count()).toBe(1);
  });

  it('createMany, and a nested create / connect / connectOrCreate on the side that holds the key', async () => {
    const { db, ann } = await populated();

    expect(await db.user.createMany({ data: [{ email: 'c1@x.tn' }, { email: 'c2@x.tn' }] })).toEqual({ count: 2 });

    const byConnect = await db.post.create({ data: { title: 'T1', author: { connect: { id: ann.id } } } });
    const byCreate = await db.post.create({ data: { title: 'T2', author: { create: { email: 'made@x.tn' } } } });
    const byEither = await db.post.create({ data: { title: 'T3', author: { connectOrCreate: { where: { email: 'ann@x.tn' }, create: { email: 'ann@x.tn' } } } } });
    const later = await db.post.create({ data: { title: 'T4', author: { connectOrCreate: { where: { email: 'late@x.tn' }, create: { email: 'late@x.tn' } } } } });

    expect(byConnect.authorId).toBe(ann.id);
    expect((await db.user.findUnique({ where: { id: byCreate.authorId } })).email).toBe('made@x.tn');
    expect(byEither.authorId).toBe(ann.id);
    expect((await db.user.findUnique({ where: { id: later.authorId } })).email).toBe('late@x.tn');
    expect((await failure(db.post.create({ data: { title: 'T5', author: { connect: { id: 999 } } } }))).code).toBe('P2025');
  });

  it('a nested write on the side that does not hold the key: create, createMany, connect, disconnect, set, update, deleteMany', async () => {
    const { db, ann, bob, first, second } = await populated();
    const author = await db.user.create({
      data: {
        email: 'writer@x.tn',
        posts: { create: [{ title: 'N1' }, { title: 'N2' }], createMany: { data: [{ title: 'N3' }] } },
      },
      include: { posts: true },
    });

    expect(author.posts.map((post: any) => post.title).sort()).toEqual(['N1', 'N2', 'N3']);

    await db.user.update({ where: { id: bob.id }, data: { posts: { connect: [{ id: first.id }, { id: second.id }] } } });
    expect((await db.post.findMany({ where: { authorId: bob.id }, orderBy: { id: 'asc' } })).map((post: any) => post.id)).toContain(first.id);

    await db.user.update({ where: { id: ann.id }, data: { reviewed: { connect: { id: second.id } } } });
    expect((await db.post.findUnique({ where: { id: second.id } })).reviewerId).toBe(ann.id);
    await db.user.update({ where: { id: ann.id }, data: { reviewed: { disconnect: { id: second.id } } } });
    expect((await db.post.findUnique({ where: { id: second.id } })).reviewerId).toBeNull();

    await db.user.update({ where: { id: ann.id }, data: { reviewed: { set: [{ id: first.id }] } } });
    expect((await db.post.findUnique({ where: { id: first.id } })).reviewerId).toBe(ann.id);

    await db.post.update({ where: { id: first.id }, data: { comments: { update: { where: { text: 'bravo' }, data: { text: 'très bien' } } } } });
    expect((await db.comment.findMany({ where: { postId: first.id } })).map((comment: any) => comment.text).sort()).toEqual(['merci', 'très bien']);

    await db.post.update({ where: { id: first.id }, data: { comments: { deleteMany: { text: 'merci' } } } });
    expect(await db.comment.count({ where: { postId: first.id } })).toBe(1);
    expect((await failure(db.post.update({ where: { id: first.id }, data: { comments: { upsert: {} } } }))).message).toContain('nested "upsert" is not supported');
  });
});

describe('MemoryPrisma: transactions', () => {
  it('a transaction that finishes keeps what it wrote', async () => {
    const { db } = world();

    await db.$transaction(async (tx: any) => {
      await tx.user.create({ data: { email: 'a@x.tn' } });
    });

    expect(await db.user.count()).toBe(1);
  });

  it('a transaction that throws undoes what it created, changed and deleted, and rethrows', async () => {
    const { db, first } = await populated();
    const before = JSON.stringify(await db.post.findMany({ orderBy: { id: 'asc' } }));
    const comments = await db.comment.count();
    const outcome = await failure(
      db.$transaction(async (tx: any) => {
        await tx.post.create({ data: { title: 'temporary', authorId: 1 } });
        await tx.post.update({ where: { id: first.id }, data: { score: 100, title: 'changed' } });
        await tx.comment.deleteMany({});
        throw new Error('boom');
      }),
    );

    expect(outcome.message).toBe('boom');
    expect(JSON.stringify(await db.post.findMany({ orderBy: { id: 'asc' } }))).toBe(before);
    expect(await db.comment.count()).toBe(comments);
  });

  it('one transaction rolling back does not undo what another one wrote', async () => {
    const { db } = await populated();
    const failing = db.$transaction(async (tx: any) => {
      await tx.user.update({ where: { id: 1 }, data: { name: 'loser' } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('boom');
    });
    const winning = db.$transaction(async (tx: any) => {
      await tx.user.update({ where: { id: 2 }, data: { name: 'winner' } });
    });

    await failure(failing);
    await winning;

    expect((await db.user.findUnique({ where: { id: 1 } })).name).toBe('Ann');
    expect((await db.user.findUnique({ where: { id: 2 } })).name).toBe('winner');
  });

  it('the array form runs every call', async () => {
    const { db } = world();

    await db.$transaction([db.user.create({ data: { email: 'a@x.tn' } }), db.user.create({ data: { email: 'b@x.tn' } })]);

    expect(await db.user.count()).toBe(2);
  });

  it('an advisory lock makes the second transaction wait until the first one is over, and nothing else is waited for', async () => {
    const { db } = world();
    const order: string[] = [];
    const lockAndWork = (name: string, key: number, pause: number) =>
      db.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${7}::int, ${key}::int)`;
        order.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, pause));
        order.push(`${name} out`);
      });

    await Promise.all([lockAndWork('A', 1, 30), lockAndWork('B', 1, 1), lockAndWork('C', 2, 1)]);

    expect(order.indexOf('A out')).toBeLessThan(order.indexOf('B in'));
    expect(order.indexOf('C in')).toBeLessThan(order.indexOf('A out'));
  });

  it('a lock is let go when the transaction fails, and raw SQL of any other kind is refused', async () => {
    const { db } = world();

    await failure(
      db.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${1}::int, ${1}::int)`;
        throw new Error('boom');
      }),
    );
    await db.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${1}::int, ${1}::int)`;
    });

    expect((await failure(db.$queryRaw`SELECT 1`)).message).toContain('does not run raw SQL');
  });
});

describe('MemoryPrisma: for a spec', () => {
  it('rows() gives the table itself, seed() adds a row without the journal, snapshot() copies, and changedTables() names what differs', async () => {
    const { memory, db } = world();
    const before = memory.snapshot();

    memory.seed('user', { email: 'seed@x.tn' });
    expect(memory.rows('User').length).toBe(1);
    expect(memory.changedTables(before)).toEqual(['User']);
    expect(memory.changedTables(before, ['User'])).toEqual([]);

    const again = memory.snapshot();

    await db.user.findMany();
    expect(memory.changedTables(again)).toEqual([]);

    memory.rows('user')[0].name = 'edited';
    expect(memory.changedTables(again)).toEqual(['User']);
    expect(() => memory.rows('Nothing')).toThrow('no model');
  });

  it('restore() puts the tables back as a snapshot had them', async () => {
    const { memory, db } = await populated();
    const before = memory.snapshot();

    await db.post.deleteMany({});
    await db.user.update({ where: { id: 1 }, data: { name: 'changed' } });
    expect(memory.changedTables(before).sort()).toEqual(['Post', 'User']);

    memory.restore(before);

    expect(memory.changedTables(before)).toEqual([]);
    expect(await db.post.count()).toBe(3);
    expect((await db.user.findUnique({ where: { id: 1 } })).name).toBe('Ann');
  });

  it('plant() fills what the spec does not say, counts unique text, and refuses to invent the parent of a row', async () => {
    const { memory } = world();
    const user = memory.plant('user', { email: 'a@x.tn' });

    expect(user).toMatchObject({ kind: 'A', active: true, name: null });

    const profile = memory.plant('profile', { userId: user.id });

    expect(profile.userId).toBe(user.id);
    expect(() => memory.plant('profile', {})).toThrow('userId points at another row');

    const first = memory.plant('post', { authorId: user.id });
    const second = memory.plant('post', { authorId: user.id });

    expect([first.title, second.title]).toEqual(['post.title', 'post.title']);
    expect([first.score, second.score]).toEqual([0, 0]);

    const comment = memory.plant('comment', { postId: first.id });
    const other = memory.plant('comment', { postId: first.id });

    expect(comment.text === other.text).toBe(false);
  });

  it('calls lists every call made on a model, in order', async () => {
    const { memory, db } = world();

    await db.user.create({ data: { email: 'a@x.tn' } });
    await db.user.findMany();
    await db.user.update({ where: { id: 1 }, data: { name: 'x' } });

    expect(memory.calls).toEqual(['user.create', 'user.findMany', 'user.update']);
  });

  it('$transaction([a, b]) waits for the operations that were started, and gives their results in order', async () => {
    const { memory, db } = world();

    const [created, listed] = await db.$transaction([db.user.create({ data: { email: 'a@x.tn' } }), db.user.findMany()]);

    expect(created.email).toBe('a@x.tn');
    expect(Array.isArray(listed)).toBe(true);
    expect(memory.rows('user')).toHaveLength(1);
  });
});
