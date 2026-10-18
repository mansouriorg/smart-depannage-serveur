import { balanced, readSource, stripComments } from '../testing/source-scan';

/**
 * P1-08 guard: what a customer, a visitor with the link, an artisan or a socket receives goes through
 * a view (src/common/views/views.ts), never the row from the database. It reads the source: a text
 * scan that stops mistakes, not someone determined (the same answer is also checked, with planted
 * secrets, by the *.views.spec.ts files next to the services).
 */

const code = (rel: string) => stripComments(readSource(rel));

/** The text of `name(...) {...}` (signature included) in a source text, or '' when there is none. */
function methodOf(source: string, name: string): string {
  const found = new RegExp(`\\n\\s*(?:private\\s+|public\\s+)?(?:async\\s+)?${name}\\s*\\(`).exec(source);

  if (!found) return '';

  const parenthesis = found.index + found[0].length - 1;
  const params = balanced(source, parenthesis);
  const open = source.indexOf('{', parenthesis + params.length + 2);

  return source.slice(found.index, open + balanced(source, open).length + 2);
}

/** The text of `function name(...) {...}` (exported or not) in a source text, or '' when there is none. */
function functionOf(source: string, name: string): string {
  const found = new RegExp(`\\n(?:export )?function ${name}\\s*\\(`).exec(source);

  if (!found) return '';

  const parenthesis = found.index + found[0].length - 1;
  const params = balanced(source, parenthesis);
  const open = source.indexOf('{', parenthesis + params.length + 2);

  return source.slice(found.index, open + balanced(source, open).length + 2);
}

/** The `return ...;` statements of a method, each as text. */
function returnsOf(method: string): string[] {
  const out: string[] = [];
  const pattern = /\breturn\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(method))) {
    let depth = 0;
    let end = match.index + 6;

    for (; end < method.length; end++) {
      const ch = method[end];

      if ('({['.includes(ch)) depth++;
      if (')}]'.includes(ch)) depth--;
      if (depth === 0 && ch === ';') break;
    }

    out.push(method.slice(match.index, end).trim());
  }

  return out;
}

/** Every call of `name(` in a text: its arguments, split at depth 0. */
function callsOf(text: string, name: string): string[][] {
  const out: string[][] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const body = balanced(text, match.index + match[0].length - 1);
    const args: string[] = [];
    let depth = 0;
    let from = 0;

    for (let i = 0; i < body.length; i++) {
      const ch = body[i];

      if ('({['.includes(ch)) depth++;
      if (')}]'.includes(ch)) depth--;
      if (depth === 0 && ch === ',') {
        args.push(body.slice(from, i).trim());
        from = i + 1;
      }
    }

    args.push(body.slice(from).trim());
    out.push(args.filter(Boolean));
  }

  return out;
}

const VIEW = /\b(?:interventionFor(?:Client|Tracking|Board|Room|Artisan)|quotesForParties|quoteForParties|paymentForClient|paymentForArtisan|eventsForParties|messageForParties|messagesFor|withoutStaffFields|forMarketplace|forReader|forTheArtisan)\b/;

describe('the routes of the customer and of the visitor with the link answer with a view (P1-08)', () => {
  it('ClientInterventionsService', () => {
    const source = code('modules/client-interventions/client-interventions.service.ts');

    for (const name of ['create', 'findMine', 'findOneMine', 'publicTracking', 'cancel']) {
      const returns = returnsOf(methodOf(source, name));

      expect(returns.length).toBeGreaterThan(0);
      expect(returns.filter((statement) => !VIEW.test(statement))).toEqual([]);
    }
  });

  it('GuestService: the routes of the link', () => {
    const source = code('modules/guest/guest.service.ts');

    for (const name of ['createGuestIntervention', 'track', 'getQuotes', 'acceptQuote', 'rejectQuote', 'requestQuoteModification', 'createGuestPayment', 'submitFeedback']) {
      const method = methodOf(source, name);
      const returns = returnsOf(method).filter((statement) => !/^return (?:undefined|null|void)\b/.test(statement));

      expect(method).not.toBe('');
      expect(returns.length).toBeGreaterThan(0);
      expect(returns.filter((statement) => !VIEW.test(statement) && !/^return \{[\s\S]*(?:intervention: publicRequest|payment: paymentForClient)/.test(statement))).toEqual([]);
    }

    // the row with its relations (the account behind the request included) never leaves the two
    // private finders (the second one asks for four columns only)
    expect(source.match(/return intervention;/g)?.length).toBe(2);
    expect(methodOf(source, 'findInterventionByPublicToken')).toContain('return intervention;');
    expect(methodOf(source, 'findForLink')).toContain('return intervention;');
  });

  it('InterventionsService: the routes of a customer, a visitor with the link and an artisan', () => {
    const source = code('modules/interventions/interventions.service.ts');

    for (const name of ['findByUser', 'findAllPending', 'findByArtisan', 'findByTrackingToken', 'submitFeedback', 'reportActiveIssue']) {
      const returns = returnsOf(methodOf(source, name));

      expect(returns.length).toBeGreaterThan(0);
      expect(returns.filter((statement) => !VIEW.test(statement))).toEqual([]);
    }

    // the one route for every role: staff read the row, the three others each have a view
    const actor = methodOf(source, 'findOneForActor');
    const returns = returnsOf(actor);

    expect(returns.filter((statement) => !VIEW.test(statement))).toEqual(['return intervention']);
    expect(actor.indexOf('return intervention;')).toBeLessThan(actor.indexOf('Role.CLIENT'));
    expect(actor).toMatch(/isTicketStaff\(actor\.role\)\) \{\s*return intervention;/);
  });

  it('MessagesService: every message that leaves goes through forReader', () => {
    const source = code('modules/messages/messages.service.ts');

    for (const name of ['create', 'findByIntervention', 'findOne', 'markAsRead', 'remove']) {
      const returns = returnsOf(methodOf(source, name));

      expect(returns.length).toBeGreaterThan(0);
      expect(returns.filter((statement) => !/forReader/.test(statement))).toEqual([]);
    }
  });

  it('the timelines: the back office with the authors, everybody else the lines meant for them', () => {
    const source = code('modules/intervention-workflow/intervention-workflow.service.ts');

    expect(methodOf(source, 'getTimeline')).toMatch(/isAdminRole\(user\.role\)[\s\S]*eventsForParties\(events\)/);
    expect(methodOf(source, 'getPublicTimeline')).toContain('timeline: eventsForParties(events)');
  });

  it('the conversation is asked of the database for the reader\'s chats, and no deleted message', () => {
    expect(code('modules/client-interventions/client-interventions.service.ts')).toMatch(/deletedAt: null, audience: \{ in: chatsOf\('client'\)/);
    expect(code('modules/artisans/artisans.service.ts')).toMatch(/deletedAt: null, audience: \{ in: chatsOf\('artisan'\)/);
  });

  it('the artisan\'s own messages to the customer and to the support', () => {
    const source = code('modules/artisans/artisans.service.ts');

    for (const name of ['contactClient', 'contactAdmin']) {
      expect(returnsOf(methodOf(source, name))).toEqual(['return messageForParties(message, userId)']);
    }
  });
});

describe('the sockets push a view to the customer, the artisan and the room (P1-08)', () => {
  it('RealtimeService: nothing but a view goes to a room that is not the dashboard', () => {
    const source = code('modules/realtime/realtime.service.ts');

    for (const to of ['emitToClient', 'emitToArtisan', 'emitToIntervention', 'emitToUser']) {
      for (const args of callsOf(source, to)) {
        const payload = args[args.length - 1];

        // the live position is the artisan's own coordinates, sent while they are on the way
        if (args.some((arg) => arg === "'artisan.location.updated'")) continue;

        expect(payload).not.toBe('payload');
        expect(payload).not.toMatch(/^(?:message|intervention|complaint|payment|quote)$/);
      }
    }

    // the dashboard is the one that gets the whole payload
    expect(callsOf(source, 'emitToAdmins').length).toBeGreaterThan(0);
  });

  it('the older gateway: the staff the row, a copy of their own for the customer and the artisan', () => {
    const source = code('modules/interventions/interventions.gateway.ts');
    const status = methodOf(source, 'sendInterventionStatus');

    expect(status).toMatch(/emit\(event, interventionForClient\(intervention\)\)/);
    expect(status).toMatch(/emit\(event, interventionForArtisan\(intervention\)\)/);
    expect(status.match(/\.emit\(/g)?.length).toBe(3);
  });

  it('the new gateway: the position of the artisan reaches the room of the job only on the way', () => {
    const source = code('modules/realtime/realtime.gateway.ts');
    const method = methodOf(source, 'updateArtisanLocation');

    expect(method).toMatch(/if \(artisanPositionIsShared\(intervention\.status\)\) \{\s*this\.emitToIntervention\(/);
  });
});

describe('the views are lists of what is allowed, not of what is forbidden (P1-08)', () => {
  const source = code('common/views/views.ts');

  it('the customer\'s, the visitor\'s, the board\'s and the room\'s copy start from the columns the table gives them', () => {
    for (const name of ['interventionForClient', 'interventionForTracking', 'interventionForBoard', 'interventionForRoom']) {
      const method = functionOf(source, name);

      expect(method).not.toBe('');
      expect(method).toMatch(/withColumns\(row, '(?:client|tracking|board|room)'\)/);
      expect(method).not.toMatch(/\.\.\.row\b/);
    }
  });

  it('the older names are the views', () => {
    const redaction = code('modules/interventions/intervention-redaction.ts');

    expect(redaction).toContain('staffOnlyInterventionColumns()');
    expect(redaction).toMatch(/return interventionForArtisan\(row\)/);
    expect(redaction).toMatch(/return interventionForBoard\(row\)/);
  });

  it('the filter on every answer stays registered, as a second line', () => {
    expect(code('app.module.ts')).toMatch(/provide: APP_INTERCEPTOR, useClass: StripStaffFieldsInterceptor/);
  });
});
