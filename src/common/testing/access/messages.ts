import { Scenario, SelfScenario } from '../access-matrix';
import { Household, World, mark } from '../world';

const job = (h: Household, w: World) => w.ids[h].intervention;

/** The three chats of a job: who is in each. */
const CHATS = {
  CLIENT_ARTISAN: { allowed: ['client', 'artisan', 'backOffice'], id: 'messageClientArtisan', text: 'message client to artisan' },
  CLIENT_SUPPORT: { allowed: ['client', 'backOffice'], id: 'messageClientSupport', text: 'message client to support' },
  ARTISAN_SUPPORT: { allowed: ['artisan', 'backOffice'], id: 'messageArtisanSupport', text: 'message artisan to support' },
} as const;

const chats = Object.entries(CHATS) as Array<[keyof typeof CHATS, (typeof CHATS)[keyof typeof CHATS]]>;

/** What a person of the household must not see of the chats they are not in. */
const hiddenChats = (h: Household, person: { role: string }) =>
  person.role === 'CLIENT' ? [mark(h, CHATS.ARTISAN_SUPPORT.text)] : person.role === 'ARTISAN' ? [mark(h, CHATS.CLIENT_SUPPORT.text)] : [];

export const messageScenarios: Scenario[] = [
  ...chats.map(
    ([audience, chat]): Scenario => ({
      route: 'POST /messages/interventions/:',
      note: `writing in the ${audience} chat`,
      allowed: [...chat.allowed],
      request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { audience, content: 'Bonjour' } }),
    }),
  ),
  {
    route: 'GET /messages/interventions/:',
    note: 'the chats of the job, each person with the chats they are in',
    allowed: ['client', 'artisan', 'backOffice'],
    reads: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) }, query: {} }),
    hidden: hiddenChats,
  },
  ...chats.map(
    ([audience, chat]): Scenario => ({
      route: 'GET /messages/interventions/:',
      note: `asking for the ${audience} chat only`,
      allowed: [...chat.allowed],
      reads: true,
      request: (h, w) => ({ params: { interventionId: job(h, w) }, query: { audience } }),
    }),
  ),
  {
    route: 'GET /messages/interventions/:/unread/count',
    allowed: ['client', 'artisan', 'backOffice'],
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  ...chats.map(
    ([audience, chat]): Scenario => ({
      route: 'PATCH /messages/interventions/:/read',
      note: `reading the ${audience} chat`,
      allowed: [...chat.allowed],
      request: (h, w) => ({ params: { interventionId: job(h, w) }, query: { audience } }),
    }),
  ),
  ...chats.map(
    ([audience, chat]): Scenario => ({
      route: 'GET /messages/:',
      note: `one message of the ${audience} chat`,
      allowed: [...chat.allowed],
      reads: true,
      request: (h, w) => ({ params: { messageId: w.ids[h][chat.id] } }),
    }),
  ),
  ...chats.map(
    ([audience, chat]): Scenario => ({
      route: 'PATCH /messages/:/read',
      note: `marking one message of the ${audience} chat as read`,
      allowed: [...chat.allowed],
      request: (h, w) => ({ params: { messageId: w.ids[h][chat.id] } }),
    }),
  ),
  ...chats.map(
    ([audience, chat]): Scenario => ({
      route: 'DELETE /messages/:',
      note: `deleting a message of the ${audience} chat: its writer, or the back office`,
      allowed: [audience === 'ARTISAN_SUPPORT' ? 'artisan' : 'client', 'backOffice'],
      request: (h, w) => ({ params: { messageId: w.ids[h][chat.id] } }),
    }),
  ),
  {
    route: 'POST /messages/admin-notes/interventions/:',
    note: 'internal notes belong to the back office',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { interventionId: job(h, w) }, body: { content: 'À vérifier' } }),
  },
  {
    route: 'GET /messages/admin-notes/interventions/:',
    allowed: ['backOffice'],
    reads: true,
    request: (h, w) => ({ params: { interventionId: job(h, w) } }),
  },
  {
    route: 'DELETE /messages/admin-notes/:',
    allowed: ['backOffice'],
    request: (h, w) => ({ params: { noteId: w.ids[h].adminNote } }),
  },
];

export const messageSelfScenarios: SelfScenario[] = [
  {
    route: 'GET /messages/unread/count',
    note: 'a number: household B has more unread messages than A, so a count of somebody else\'s shows',
    request: () => ({}),
    prepare: (w) => {
      // two more messages from each of the two people of B, to the other (the chat of the customer and the artisan)
      for (let n = 0; n < 2; n++) {
        for (const [from, text] of [['client', 'client'], ['artisan', 'artisan']] as const) {
          w.fill('message', { interventionId: w.ids.B.intervention, senderId: w.ids.B[from], audience: 'CLIENT_ARTISAN', content: mark('B', `extra message of the ${text} ${n}`) });
        }
      }
    },
    // A: the customer has nothing to read, the artisan reads the customer's message; B: two more each way
    answer: (person, value) => {
      if (person.household === null) return null;

      const expected = { clientA: 0, artisanA: 1, clientB: 2, artisanB: 3 }[person.key as 'clientA' | 'artisanA' | 'clientB' | 'artisanB'];

      return (value as { total?: number })?.total === expected ? null : `was told a number of unread messages that is not theirs: ${JSON.stringify(value)}`;
    },
  },
];
