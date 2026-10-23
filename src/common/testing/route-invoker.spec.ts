import { FakeResponse, Router, argumentsFor, handlerOf } from './route-invoker';
import { scanController } from './route-roles';

const SAMPLE = `
import { Controller } from '@nestjs/common';

@Controller('notes')
@UseGuards(JwtAuthGuard)
export class NotesController {
  /** GET /notes/:noteId */
  @Get(':noteId')
  show(
    @CurrentUser('id') userId: number,
    @CurrentUser('role') role: Role,
    @Param('noteId', ParseIntPipe) noteId: number,
    @Query('lang') lang?: string,
  ) {
    return this.service.show(userId, role, noteId, lang);
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateNoteDto, @Body('title') title: string) {
    return this.service.create(user, dto, title);
  }

  @Get('export/:format')
  @Header('Cache-Control', 'no-store')
  export(@Request() req, @Param('format') format: string, @Query() query: any, @Res() res: Response) {
    res.type('text/csv');
    res.send(this.service.export(req.user.id, format, query));
  }

  @Delete(':noteId')
  remove(@CurrentUser('id') userId: number, @Param('noteId', ParseIntPipe) noteId: number, @Ip() ip: string, @UploadedFile() file: any) {
    return this.service.remove(userId, noteId, ip, file);
  }
}
`;

function controller() {
  const seen: any[][] = [];
  const instance = {
    show: (...args: any[]) => (seen.push(['show', ...args]), 'shown'),
    create: async (...args: any[]) => (seen.push(['create', ...args]), 'created'),
    export: (req: any, format: string, query: any, res: any) => {
      seen.push(['export', req.user.id, format, query]);
      res.type('text/csv');
      res.send('a,b');
    },
    remove: (...args: any[]) => (seen.push(['remove', ...args]), 'removed'),
  };

  return { seen, router: new Router([{ source: SAMPLE, instance }], []) };
}

const USER = { id: 7, role: 'CLIENT', email: 'a@x.tn' };

describe('route invoker: reading the method behind a route', () => {
  it('finds the name and the decorator of every parameter, whatever sits between the route decorator and the name', () => {
    const routes = scanController(SAMPLE, []);
    const show = handlerOf(routes[0]);
    const create = handlerOf(routes[1]);
    const exported = handlerOf(routes[2]);

    expect(show.name).toBe('show');
    expect(show.parameters.map((p) => p.decorator)).toEqual(['CurrentUser', 'CurrentUser', 'Param', 'Query']);
    expect(show.parameters[2].args).toEqual(["'noteId'", 'ParseIntPipe']);
    expect(create.name).toBe('create');
    expect(create.parameters.map((p) => p.decorator)).toEqual(['CurrentUser', 'Body', 'Body']);
    expect(exported.name).toBe('export');
    expect(exported.parameters.map((p) => p.decorator)).toEqual(['Request', 'Param', 'Query', 'Res']);
  });

  it('gives the router the same arguments Nest would: the caller, the pipes, the body, the query', () => {
    const [show, create] = scanController(SAMPLE, []).map(handlerOf);
    const response = new FakeResponse();

    expect(argumentsFor(show, { user: USER, params: { noteId: '12' }, query: { lang: 'fr' } }, response)).toEqual([7, 'CLIENT', 12, 'fr']);
    expect(argumentsFor(create, { user: USER, body: { title: 'T', text: 'x' } }, response)).toEqual([USER, { title: 'T', text: 'x' }, 'T']);
  });

  it('a parameter that the pipe refuses is a 400 before the method runs, and a decorator it does not know is an error, not a guess', async () => {
    const { router, seen } = controller();
    const refused: any = await router.call('GET /notes/:', { user: USER, params: { noteId: 'abc' } }).catch((error) => error);

    expect(refused.status).toBe(400);
    expect(seen).toEqual([]);

    const odd = scanController('@Controller("x")\nexport class X {\n @Get("a")\n run(@Weird() w: any) { return w; }\n}', []);

    expect(() => argumentsFor(handlerOf(odd[0]), {}, new FakeResponse())).toThrow('not known to the invoker');
  });
});

describe('route invoker: calling a route', () => {
  it('calls the method of the route with the request, and gives back what it returned', async () => {
    const { router, seen } = controller();
    const result = await router.call('GET /notes/:', { user: USER, params: { noteId: 3 }, query: { lang: 'ar' } });

    expect(result.value).toBe('shown');
    expect(result.handler).toBe('show');
    expect(seen).toEqual([['show', 7, 'CLIENT', 3, 'ar']]);
  });

  it('the route is the key, parameter names do not matter, and an unknown route is an error', async () => {
    const { router } = controller();

    expect(router.has('GET /notes/:')).toBe(true);
    expect(router.has('POST /notes')).toBe(true);
    expect(router.has('GET /notes')).toBe(false);
    expect(() => router.route('GET /nothing')).toThrow('no route GET /nothing');
  });

  it('a route that answers through the response gives what was sent, with its headers', async () => {
    const { router } = controller();
    const result = await router.call('GET /notes/export/:', { user: USER, params: { format: 'csv' }, query: { a: 1 } });

    expect(result.value).toBe('a,b');
    expect(result.response.headers['content-type']).toBe('text/csv');
  });

  it('a method that throws throws through the call', async () => {
    const instance = {
      show: () => {
        throw new Error('refused');
      },
    };
    const router = new Router([{ source: SAMPLE, instance }], []);

    await expect(router.call('GET /notes/:', { user: USER, params: { noteId: 1 } })).rejects.toThrow('refused');
  });

  it('the controller must have the method that the route names', async () => {
    const router = new Router([{ source: SAMPLE, instance: {} }], []);

    await expect(router.call('GET /notes/:', { user: USER, params: { noteId: 1 } })).rejects.toThrow('no method show');
  });

  it('two controllers with the same route are refused', () => {
    expect(() => new Router([{ source: SAMPLE, instance: {} }, { source: SAMPLE, instance: {} }], [])).toThrow('declared twice');
  });
});
