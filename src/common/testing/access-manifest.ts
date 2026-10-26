/**
 * The routes that the wrong-user scenarios (`access/*.ts`) do not cover, and why each is safe (P1-17).
 *
 * `route-inventory.spec.ts` reads every controller and puts each route in one of these places:
 *
 *  - a scenario (the person is somebody else's customer or artisan, or a link that is not theirs),
 *    in `access/all.ts`;
 *  - the back office alone, by `@Roles` that the application's own `RolesGuard` enforces (checked
 *    for every role in the same spec);
 *  - this file.
 *
 * A route that is in none of them fails the build: a new endpoint comes with its wrong-user test, or
 * with a line here that says who may call it and names the test that proves it.
 *
 * `open`: anybody may call it and it shows nothing that belongs to a person.
 * `proved`: the call belongs to the caller (or to the one who holds a code or a link), and a test in
 * another file shows that a wrong person gets nothing and changes nothing. `proof` names that test:
 * the file, and a text that the file must contain, so that renaming the test is seen.
 */

export interface Proof {
  /** Relative to `src`. */
  file: string;
  /** A text the file holds (the title of the test, or of its group). */
  mentions: string;
}

export type ManifestEntry =
  | { kind: 'open'; why: string }
  | { kind: 'proved'; why: string; proof: Proof[] };

const AUTH = 'modules/auth/auth.wrong-user.spec.ts';
const CONTACT = 'modules/users/contact-change.service.spec.ts';
const GUEST = 'modules/guest/guest-activation.spec.ts';

export const ACCESS_MANIFEST: Record<string, ManifestEntry> = {
  // ------------------------------------------------------------------ nothing of anybody's
  'GET /': { kind: 'open', why: 'the greeting of the server: a fixed text' },
  'GET /services': { kind: 'open', why: 'the catalogue of services and prices the website shows to everyone' },
  'GET /services/type/:': { kind: 'open', why: 'the same catalogue, for one trade' },
  'GET /services/sub-services/:': { kind: 'open', why: 'the same catalogue, for one service' },
  'GET /service-zones': { kind: 'open', why: 'the list of the zones the platform serves' },
  'GET /guest/challenge': { kind: 'open', why: 'a question for the bot check: it holds nothing of anybody' },

  'GET /payments/webhooks/:': {
    kind: 'open',
    why: 'the card provider calls it when a payment changes: the call only tells which payment to look up, and the server asks the provider itself before it believes anything (P2-10)',
  },
  'POST /payments/webhooks/:': {
    kind: 'open',
    why: 'the same call, sent as a POST by a provider that posts: nothing in it is believed, the provider is asked (P2-10)',
  },

  // ------------------------------------------------------------------ signing in and out, and the codes sent to somebody
  'POST /auth/login': {
    kind: 'proved',
    why: 'a wrong password, another person’s password and an unknown e-mail are refused alike',
    proof: [{ file: AUTH, mentions: 'POST /auth/login with the wrong person' }],
  },
  'POST /auth/refresh': {
    kind: 'proved',
    why: 'a token is good for its own session only, once; a token for another person’s session is refused',
    proof: [{ file: AUTH, mentions: 'POST /auth/refresh with the wrong person' }],
  },
  'POST /auth/logout': {
    kind: 'proved',
    why: 'it ends the session of the token it is given and no other',
    proof: [{ file: AUTH, mentions: 'POST /auth/logout and /auth/logout-everywhere with the wrong person' }],
  },
  'POST /auth/logout-everywhere': {
    kind: 'proved',
    why: 'it ends the caller’s sessions and nobody else’s',
    proof: [{ file: AUTH, mentions: 'logging out everywhere ends the caller' }],
  },
  'POST /auth/forgot-password': {
    kind: 'proved',
    why: 'the same answer for an account and for an e-mail nobody has; the mail goes to the owner of the address',
    proof: [{ file: AUTH, mentions: 'POST /auth/forgot-password and /auth/reset-password with the wrong person' }],
  },
  'POST /auth/reset-password': {
    kind: 'proved',
    why: 'the link changes the password of the account it was sent for, once',
    proof: [{ file: AUTH, mentions: 'the link changes the password of the account it was sent for' }],
  },
  'POST /auth/change-password': {
    kind: 'proved',
    why: 'it needs the password of the caller and changes the caller’s alone',
    proof: [{ file: AUTH, mentions: 'POST /auth/change-password with the wrong person' }],
  },
  'POST /auth/email/send-verification': {
    kind: 'proved',
    why: 'it writes to the caller’s own address',
    proof: [{ file: AUTH, mentions: 'POST /auth/email/send-verification and /auth/email/verify with the wrong person' }],
  },
  'POST /auth/email/verify': {
    kind: 'proved',
    why: 'the link verifies the account it was sent for, once',
    proof: [{ file: AUTH, mentions: 'the link verifies that account only, once' }],
  },
  'POST /auth/phone/send-code': {
    kind: 'proved',
    why: 'it sends the code to the caller’s own number',
    proof: [{ file: AUTH, mentions: 'POST /auth/phone/send-code and /auth/phone/verify with the wrong person' }],
  },
  'POST /auth/phone/verify': {
    kind: 'proved',
    why: 'the code is bound to the user it was made for',
    proof: [{ file: AUTH, mentions: 'the code verifies that account only' }],
  },
  'POST /auth/register': {
    kind: 'proved',
    why: 'a number or an address that belongs to an account, or to a guest profile, is not taken over',
    proof: [{ file: 'modules/users/users.contact.spec.ts', mentions: 'a guest profile with the same e-mail OR the same number is not taken over' }],
  },

  // ------------------------------------------------------------------ the account of the caller
  'POST /users/me/email-change': {
    kind: 'proved',
    why: 'it needs the caller’s password and writes to the new address only',
    proof: [
      { file: AUTH, mentions: 'needs the password of the caller: somebody else' },
      { file: CONTACT, mentions: 'sends the link to the NEW address only, and changes nothing before it is clicked' },
    ],
  },
  'POST /users/email-change/confirm': {
    kind: 'proved',
    why: 'the link changes the address of the account it was made for, once',
    proof: [
      { file: AUTH, mentions: 'the link of one person' },
      { file: CONTACT, mentions: 'a link works once' },
    ],
  },
  'POST /users/me/phone-change': {
    kind: 'proved',
    why: 'it needs the caller’s password and sends the code to the new number only',
    proof: [
      { file: AUTH, mentions: 'needs the password of the caller: somebody else' },
      { file: CONTACT, mentions: 'sends a code to the NEW number and changes nothing before it is typed' },
    ],
  },
  'POST /users/me/phone-change/confirm': {
    kind: 'proved',
    why: 'the code works for the user it was made for, once',
    proof: [{ file: CONTACT, mentions: 'a code works once, only for its own user' }],
  },
  'DELETE /users/me': {
    kind: 'proved',
    why: 'it closes the caller’s account and nobody else’s',
    proof: [{ file: AUTH, mentions: 'DELETE /users/me with the wrong person' }],
  },

  // ------------------------------------------------------------------ requests made by somebody with no account
  'POST /artisans/apply': {
    kind: 'proved',
    why: 'an address or a number that belongs to an account is refused, and the same person cannot apply twice',
    proof: [
      { file: 'modules/artisans/artisans.apply.spec.ts', mentions: 'an e-mail that belongs to a client account is refused' },
      { file: 'modules/artisans/artisans.apply.spec.ts', mentions: 'a number already on another account is refused whatever the spelling' },
    ],
  },
  'POST /interventions': {
    kind: 'proved',
    why: 'an existing account is never reused: its owner must sign in; only a guest profile is, and a profile with a mailbox of its own is not',
    proof: [{ file: 'modules/interventions/interventions.guest-phone.spec.ts', mentions: 'a real account with that number is never reused: 409' }],
  },
  'POST /guest/interventions': {
    kind: 'proved',
    why: 'the answer does not say whose profile the request went to, and a profile seeded by somebody else is not joined',
    proof: [
      { file: 'modules/guest/guest-request.spec.ts', mentions: 'the answer does not say whose profile the request went to' },
      { file: GUEST, mentions: 'somebody seeded a profile with the victim' },
    ],
  },
  'POST /guest/account/request-activation': {
    kind: 'proved',
    why: 'it does not say whether a profile exists, and the messages go to the profile’s own mailbox and number',
    proof: [{ file: GUEST, mentions: 'does not say whether a profile exists' }],
  },
  'POST /guest/account/activate': {
    kind: 'proved',
    why: 'a code made for one guest does not open another, and wrong codes are counted',
    proof: [
      { file: GUEST, mentions: 'a code made for one guest does not open another' },
      { file: GUEST, mentions: 'five wrong codes lock the number' },
    ],
  },
};

/**
 * The live events (websocket gateways). `route-inventory.spec.ts` reads every `@SubscribeMessage('event')` and every
 * `handleConnection` of the gateways: one that is not here fails the build, as a route does. The key is the file and the
 * event; the proof is the test that tries it with the wrong person.
 */
const LIVE = 'modules/realtime/realtime.gateway.wrong-user.spec.ts';

export const GATEWAY_MANIFEST: Record<string, ManifestEntry> = {
  'realtime.gateway.ts handleConnection': { kind: 'proved', why: 'a token opens the rooms of its own person and the back office rooms for the back office only', proof: [{ file: LIVE, mentions: 'a token opens the rooms of its own person only' }] },
  'realtime.gateway.ts ping': { kind: 'proved', why: 'answers with the id of the socket\'s own person', proof: [{ file: LIVE, mentions: 'ping answers with the id of the socket' }] },
  'realtime.gateway.ts intervention.join': { kind: 'proved', why: 'the customer and the artisan of the job and the back office only', proof: [{ file: LIVE, mentions: 'lets in the customer and the artisan of the job and the back office' }] },
  'realtime.gateway.ts intervention.leave': { kind: 'proved', why: 'a socket leaves its own rooms only', proof: [{ file: LIVE, mentions: 'leaving a room moves only the socket that asks' }] },
  'realtime.gateway.ts admin.dashboard.join': { kind: 'proved', why: 'the back office only', proof: [{ file: LIVE, mentions: 'the back office joins; customers and artisans are refused' }] },
  'realtime.gateway.ts artisan.location.update': { kind: 'proved', why: 'the artisan of the job and the staff who work on tickets; not another artisan, a customer or the accountant', proof: [{ file: LIVE, mentions: 'another artisan, a customer, the other household and the accountant are refused' }] },
  'notifications.gateway.ts handleConnection': { kind: 'proved', why: 'a login token only, and the rooms of its own person', proof: [{ file: LIVE, mentions: 'no token, a token that is not a login token and a closed account' }] },
  'interventions.gateway.ts handleConnection': { kind: 'proved', why: 'a login token only, a closed account is turned away, and the staff room is for the staff who work on tickets', proof: [{ file: LIVE, mentions: 'the older gateway: connecting with the wrong person' }] },
  'interventions.gateway.ts sendPosition': { kind: 'proved', why: 'only an artisan, stamped with the caller\'s own id', proof: [{ file: LIVE, mentions: 'only an artisan sends a position' }] },
};
