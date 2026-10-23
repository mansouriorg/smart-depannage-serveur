import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;
const appointment = (h: Household, w: World) => w.ids[h].appointment;
const DAY = '2026-11-02';
/** The day as the server reads it: by the clock of the machine it runs on, so that the visit, the day asked for and the window agree in every time zone. */
const LOCAL = (hour: number) => new Date(2026, 10, 2, hour, 0, 0);

/**
 * What the customer and the artisan are never shown of an appointment: the back office's note, and the other
 * party's address. The back office's answer to a request is addressed to whoever asked: the customer asked
 * (the seed), so the artisan does not read it.
 */
const hiddenOnAppointment = (h: Household, person: { role: string }) =>
  person.role === 'CLIENT'
    ? [mark(h, 'Appointment.adminNote'), mark(h, 'artisan email')]
    : person.role === 'ARTISAN'
      ? [mark(h, 'Appointment.adminNote'), mark(h, 'AppointmentRequest.adminResponse')]
      : [];

const scheduled = (w: World) =>
  w.set('appointment', { status: 'SCHEDULED', startsAt: LOCAL(9), endsAt: LOCAL(11) });

export const schedulingScenarios: Scenario[] = [
  {
    route: 'POST /scheduling/interventions/:/preferred-time',
    note: 'the time the customer prefers is the customer’s to give (the back office may set it for them)',
    allowed: ['client', 'ticketStaff'],
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { preferredDate: '2026-11-03', preferredStartTime: '09:00', preferredEndTime: '11:00' } }),
    hidden: hiddenOnAppointment,
  },
  {
    route: 'GET /scheduling/interventions/:/appointment',
    allowed: ['client', 'artisan', 'ticketStaff'],
    reads: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
    hidden: hiddenOnAppointment,
  },
  {
    route: 'POST /scheduling/appointments/:/reschedule-request',
    allowed: ['client', 'artisan', 'ticketStaff'],
    request: (h, w) => ({
      params: { appointmentId: appointment(h, w) },
      body: { requestedStartAt: '2026-11-05T09:00:00.000Z', requestedEndAt: '2026-11-05T11:00:00.000Z', reason: 'Imprévu' },
    }),
    hidden: hiddenOnAppointment,
  },
  {
    route: 'POST /scheduling/appointments/:/cancel-request',
    allowed: ['client', 'artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { appointmentId: appointment(h, w) }, body: { reason: 'Plus nécessaire' } }),
    hidden: hiddenOnAppointment,
  },
  {
    route: 'PATCH /scheduling/artisan/appointments/:/accept',
    note: 'the artisan of the visit confirms it (the back office may confirm for them)',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { appointmentId: appointment(h, w) } }),
    hidden: (h, person) => (person.role === 'ARTISAN' ? hiddenOnAppointment(h, person) : []),
  },
  {
    route: 'POST /scheduling/admin/interventions/:/schedule',
    note: 'the back office plans a visit',
    allowed: ['ticketStaff'],
    prepare: (w) => {
      w.set('appointment', { status: 'REQUESTED', artisanId: null });
      w.set('intervention', { status: 'QUOTE_ACCEPTED', artisanId: null });
    },
    request: (h, w) => ({
      params: { interventionId: job(h, w) },
      body: { artisanId: w.ids[h].artisan, startsAt: `${DAY}T09:00:00.000Z`, endsAt: `${DAY}T11:00:00.000Z` },
    }),
  },
  {
    route: 'PATCH /scheduling/admin/requests/:/review',
    allowed: ['ticketStaff'],
    request: (h, w) => ({ params: { requestId: w.ids[h].appointmentRequest }, query: { approved: 'false' }, body: { adminResponse: 'Refusé' } }),
  },
  {
    route: 'GET /scheduling/admin/artisans/:/availability',
    note: 'an artisan reads their own availability, the back office everybody’s',
    allowed: ['artisan', 'ticketStaff'],
    request: (h, w) => ({ params: { artisanId: w.ids[h].artisan }, query: { date: DAY } }),
  },
  {
    route: 'GET /scheduling/artisan/daily',
    note: 'the day of an artisan: an artisan who asks for somebody else’s gets their own, never the other’s',
    allowed: ['artisan', 'ticketStaff'],
    emptyIsFine: true,
    reads: true,
    prepare: scheduled,
    request: (h, w) => ({ query: { date: `${DAY}T12:00:00`, artisanId: String(w.ids[h].artisan) } }),
  },
  {
    route: 'POST /scheduling/artisan/availability',
    note: 'a slot id of somebody else’s schedule is not found',
    allowed: ['artisan'],
    request: (h, w) => ({ body: { slotId: w.ids[h].slot, dayOfWeek: 'TUESDAY', startTime: '08:00', endTime: '12:00' } }),
  },
];

export const schedulingSelfScenarios: SelfScenario[] = [
  { route: 'GET /scheduling/admin/calendar', servedRoles: ['TICKET_STAFF'], backOfficeSeesAll: true, request: () => ({ query: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' } }) },
  { route: 'POST /scheduling/artisan/time-blocks', servedRoles: ['ARTISAN', 'TICKET_STAFF'], request: () => ({ body: { startsAt: '2026-12-03T08:00:00.000Z', endsAt: '2026-12-03T10:00:00.000Z', reason: 'Rendez-vous médical' } }) },
  { route: 'GET /scheduling/artisan/time-blocks', servedRoles: ['ARTISAN', 'TICKET_STAFF'], reads: true, request: () => ({ query: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' } }) },
];
