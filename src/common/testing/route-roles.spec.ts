import { guardsIn, rolesIn, routeKey, scanController, withoutComments } from './route-roles';

const TICKET_STAFF = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER'];

const SAMPLE = `
import { Controller } from '@nestjs/common';

@Controller('things')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
export class ThingsController {
  constructor(private readonly things: ThingsService) {}

  @Get()
  list() {
    return this.things.list();
  }

  @Post(':id/assign')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  assign(@Param('id') id: string) {
    return this.things.assign(id);
  }

  // The older routes decide in code. MUST come BEFORE @Get(':id') to avoid a clash.
  @Get('stats')
  stats(@Request() req) {
    if (!isTicketStaff(req.user.role)) {
      throw new ForbiddenException();
    }
    return this.things.stats();
  }

  @UseGuards(JwtAuthGuard)
  @Roles(
    Role.SUPPORT,
    Role.SUPER_ADMIN,
  )
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.things.remove(id);
  }
}
`;

const OPEN = `
@Controller()
export class OpenController {
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  profile() {
    return {};
  }

  @Patch("profile")
  update() {
    return {};
  }
}
`;

describe('route-roles: the roles of each route, read from a controller (P1-12)', () => {
  it('reads the roles of the class, of a method, and of a method whose @Roles sits above its route decorator', () => {
    const routes = scanController(SAMPLE, TICKET_STAFF);
    const byKey = Object.fromEntries(routes.map((route) => [routeKey(route.method, route.path), route]));

    expect(byKey['GET /things'].roles).toEqual(['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT']);
    expect(byKey['GET /things'].how).toBe('class-roles');
    expect(byKey['POST /things/:/assign'].roles).toEqual(['ADMIN', 'DISPATCHER']);
    expect(byKey['POST /things/:/assign'].how).toBe('roles');
    expect(byKey['DELETE /things/:'].roles).toEqual(['SUPPORT', 'SUPER_ADMIN']);
  });

  it('a method keeps its own roles: the roles of the method before it do not leak into it', () => {
    const routes = scanController(SAMPLE, TICKET_STAFF);
    const list = routes.find((route) => route.method === 'GET' && route.path === '/things');

    expect(list?.roles).not.toContain('DISPATCHER');
  });

  it('a method that asks isTicketStaff in its body answers to the staff list it was given, unless the class names roles', () => {
    const code = `
@Controller('interventions')
export class OldController {
  @Get('stats')
  stats(@Request() req) {
    if (!isTicketStaff(req.user.role)) {
      throw new ForbiddenException();
    }
    return 1;
  }

  @Get(':id')
  one() {
    return 2;
  }
}`;
    const routes = scanController(code, TICKET_STAFF);

    expect([routes[0].method, routes[0].path, routes[0].roles, routes[0].how]).toEqual(['GET', '/interventions/stats', TICKET_STAFF, 'ticket-staff']);
    expect([routes[1].method, routes[1].path, routes[1].roles, routes[1].how]).toEqual(['GET', '/interventions/:id', null, 'public']);
  });

  it('a route with no @Roles is open to every signed-in account when JwtAuthGuard applies, and to anybody when it does not (roles: null both ways)', () => {
    const routes = scanController(OPEN, TICKET_STAFF);

    expect(routes.map((route) => [route.method, route.path, route.roles, route.how])).toEqual([
      ['GET', '/profile', null, 'signed-in'],
      ['PATCH', '/profile', null, 'public'],
    ]);
  });

  it('does not see a route in a comment', () => {
    const routes = scanController(SAMPLE, TICKET_STAFF);

    expect(routes.map((route) => routeKey(route.method, route.path))).toEqual([
      'GET /things',
      'POST /things/:/assign',
      'GET /things/stats',
      'DELETE /things/:',
    ]);
    expect(withoutComments("a // @Get('x')\nb /* @Post('y') */ c 'http://x.tn'")).toBe("a \nb  c 'http://x.tn'");
  });

  it('rolesIn: the first @Roles of a text, and null when there is none', () => {
    expect(rolesIn('@Roles(Role.A_B, Role.C)')).toEqual(['A_B', 'C']);
    expect(rolesIn('nothing here')).toBeNull();
    expect(() => rolesIn('@Roles(')).toThrow('not closed');
    expect(() => rolesIn('@Roles()')).toThrow('names no role');
  });

  it('refuses a file that is not a controller', () => {
    expect(() => scanController('export class A {}', TICKET_STAFF)).toThrow('no @Controller');
  });

  it('routeKey: the name of a parameter does not matter', () => {
    expect(routeKey('patch', '/users/:id')).toBe(routeKey('PATCH', '/users/:userId'));
    expect(routeKey('GET', '/users/:id')).not.toBe(routeKey('POST', '/users/:id'));
  });
});

describe('route-roles: what it refuses to guess (P1-12)', () => {
  const CLASS_GUARDED = (body: string, classHeader = "@Controller('x')\n@UseGuards(JwtAuthGuard, RolesGuard)") => `${classHeader}\nexport class XController {\n${body}\n}\n`;

  it('@Roles without RolesGuard is reported as not enforced; with RolesGuard on the method or on the class it is', () => {
    const source = `
@Controller('x')
export class XController {
  @UseGuards(JwtAuthGuard)
  @Roles(Role.ADMIN)
  @Delete(':id')
  remove() {
    return 1;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Patch(':id')
  change() {
    return 2;
  }
}
`;
    const [remove, change] = scanController(source, TICKET_STAFF);

    expect(remove.roles).toEqual(['ADMIN']);
    expect(remove.rolesEnforced).toBe(false);
    expect(change.rolesEnforced).toBe(true);

    const [classWide] = scanController(CLASS_GUARDED("  @Roles(Role.ADMIN)\n  @Get()\n  list() {\n    return 1;\n  }"), TICKET_STAFF);

    expect(classWide.rolesEnforced).toBe(true);
    expect(classWide.guards).toEqual(['JwtAuthGuard', 'RolesGuard']);
  });

  it('AuthGuard(\'jwt\') counts as the JWT guard', () => {
    expect(guardsIn("@UseGuards(AuthGuard('jwt'), RolesGuard)")).toEqual(['JwtAuthGuard', 'RolesGuard']);
    expect(guardsIn('@UseGuards(RateLimitGuard)')).toEqual(['RateLimitGuard']);
    expect(guardsIn('nothing')).toEqual([]);
    expect(guardsIn('@UseGuards(Throttle(1, 2), RolesGuard)')).toEqual(['Throttle(1, 2)', 'RolesGuard']);
    expect(() => guardsIn('@UseGuards(')).toThrow('not closed');
  });

  it('a gate in the body is ticket staff; any other use of isTicketStaff is "in-code" and its roles are not known here', () => {
    const code = `
@Controller('t')
export class TController {
  @Get('gate')
  @UseGuards(JwtAuthGuard)
  gate(@Request() req) {
    if (!isTicketStaff(req.user.role)) {
      throw new ForbiddenException();
    }
    return 1;
  }

  @Get('branch')
  @UseGuards(JwtAuthGuard)
  branch(@Request() req) {
    if (isTicketStaff(req.user.role)) {
      return 'all';
    }
    return 'own';
  }
}`;
    const [gate, branch] = scanController(code, TICKET_STAFF);

    expect([gate.how, gate.roles]).toEqual(['ticket-staff', TICKET_STAFF]);
    expect([branch.how, branch.roles]).toEqual(['in-code', null]);
  });

  it('a method on one line keeps its @Roles to itself (the next route is not given them)', () => {
    const code = CLASS_GUARDED(`  @Roles(Role.ADMIN) @Get('a') a() { return 1; }
  @Get('b') b() { return 2; }
  @Post('c') @Roles(Role.SUPPORT) c() { return 3; }`, "@Controller('x')\n@UseGuards(JwtAuthGuard, RolesGuard)");
    const routes = scanController(code, TICKET_STAFF);

    expect(routes.map((route) => [route.path, route.roles])).toEqual([
      ['/x/a', ['ADMIN']],
      ['/x/b', null],
      ['/x/c', ['SUPPORT']],
    ]);
  });

  it('a brace in a message, a property, an arrow function and a constructor do not move the end of a method', () => {
    const code = CLASS_GUARDED(`  private readonly limits = { a: 1 };
  private fixed = 3;

  constructor(private readonly service: Service) {}

  @Roles(Role.ADMIN)
  @Get('a')
  a() {
    const text = "closing } brace and { opening one";
    return [1].map((x) => { return x; });
  }

  @Get('b')
  b() {
    return 2;
  }`);
    const routes = scanController(code, TICKET_STAFF);

    expect(routes.map((route) => [route.path, route.roles])).toEqual([
      ['/x/a', ['ADMIN']],
      ['/x/b', null],
    ]);
    expect(routes[0].source).toContain('closing } brace');
    expect(routes[1].source).not.toContain('closing');
  });

  it('a decorator with an object inside its brackets (an upload with its limits) does not cut the method short', () => {
    const code = CLASS_GUARDED(`  @Roles(Role.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 }, fileFilter: (req, file, cb) => { cb(null, true); } }))
  @Post('upload')
  upload(@UploadedFile() file: { name: string }) {
    return file;
  }

  @Get('after')
  after() {
    return 1;
  }`);
    const routes = scanController(code, TICKET_STAFF);

    expect(routes.map((route) => [route.method, route.path, route.roles])).toEqual([
      ['POST', '/x/upload', ['ADMIN']],
      ['GET', '/x/after', null],
    ]);
    expect(routes[0].source).toContain('return file;');
  });

  it('a property with its own decorators does not lend them to the route that follows it', () => {
    const code = CLASS_GUARDED(`  @UseGuards(RolesGuard)
  private readonly guarded = 1;

  @Roles(Role.ADMIN)
  @Get('a')
  a() {
    return 1;
  }`, "@Controller('x')");
    const [route] = scanController(code, TICKET_STAFF);

    expect(route.guards).toEqual([]);
    expect(route.rolesEnforced).toBe(false);
  });

  it('a spread, a constant or a role written another way in @Roles is an error, not a smaller list', () => {
    expect(() => rolesIn('@Roles(...BACK_OFFICE, Role.ADMIN)')).toThrow('not Role.NAME');
    expect(() => rolesIn('@Roles(STAFF)')).toThrow('not Role.NAME');
    expect(() => rolesIn("@Roles('ADMIN')")).toThrow('not Role.NAME');
    expect(rolesIn('@Roles(\n    Role.ADMIN,\n    Role.SUPPORT,\n  )')).toEqual(['ADMIN', 'SUPPORT']);
    expect(rolesIn('@Roles(Role.ADMIN) then @Roles(Role.SUPPORT)')).toEqual(['ADMIN']);
  });

  it('a route path that is not a plain string, and a method with two routes, are errors', () => {
    expect(() => scanController(CLASS_GUARDED('  @Get(PATH)\n  a() {\n    return 1;\n  }'), TICKET_STAFF)).toThrow('not a plain string');
    expect(() => scanController(CLASS_GUARDED("  @Get(['a', 'b'])\n  a() {\n    return 1;\n  }"), TICKET_STAFF)).toThrow('not a plain string');
    expect(() => scanController(CLASS_GUARDED("  @Get('a')\n  @Post('b')\n  a() {\n    return 1;\n  }"), TICKET_STAFF)).toThrow('two route decorators');
  });

  it('reads a file saved with Windows line endings the same way', () => {
    const unix = CLASS_GUARDED("  @Roles(Role.ADMIN)\n  @Get('a')\n  a() {\n    return 1;\n  }\n\n  @Get('b')\n  b() {\n    return 2;\n  }");
    const windows = unix.replace(/\n/g, '\r\n');

    expect(scanController(windows, TICKET_STAFF).map((route) => [route.path, route.roles])).toEqual(
      scanController(unix, TICKET_STAFF).map((route) => [route.path, route.roles]),
    );
    expect(scanController(windows, TICKET_STAFF)[1].roles).toBeNull();
  });
});
