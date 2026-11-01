<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).


## API documentation and the shared package (P1-09)

- **/api/docs** (and **/api/docs/json**) is the interactive documentation of every route. It is on
  while developing and OFF in production unless `API_DOCS=true` is set. The routes and the request
  bodies are described (the Nest plugin reads the `*.dto.ts` files when the server is built or
  started with `nest build` / `nest start`); a body class declared inside a controller file is not.
- **The types the apps use** do not come from the documentation. They come from the real code:
  `npm run contract:generate` runs the views of `src/common/views` on rows built from
  `prisma/schema.prisma` and writes the types, the status table and the `{ data, meta }` page type
  to `../smart-depannage-shared/src/generated`. Then `npm run sync` in `smart-depannage-shared`
  copies the package into the admin, the website and the mobile app (`lib/shared`).
- `npm run contract:check` fails when the generated folder is out of date: run it after changing a
  column, a view, the status table or the page type. When `smart-depannage-shared` sits next to the server, the test in `src/common/api-contract` fails too.
- The page type (`paginated()` in `src/common/api-contract/envelope.ts`) is the only place that
  writes a `meta`: a service that builds its own does not pass the tests.


## Scheduling: two bookings for one artisan (P3-01)

The code refuses a second visit on an hour an artisan already holds (the availability check under the artisan's lock). PostgreSQL
refuses it too, whatever wrote the row: an exclusion constraint on `Appointment` (`Appointment_artisan_no_overlap`). Prisma's schema
cannot say it, so it is applied by a script, once per database. This step is not part of a deploy: until somebody runs it, only the
code check holds.

Order of the update:

1. Stop the reminders from running on the old code, or deploy in one go: the new code writes a notification type
   (`APPOINTMENT_REMINDER`) that a database which has not had step 2 yet does not know.
2. `npx prisma generate && npx prisma db push` (new notification type `APPOINTMENT_REMINDER`, new column `AppointmentRequest.previousStatus`).
3. Deploy the new code.
4. `npm run scheduling:constraints` is a dry run: it lists the pairs of visits of one artisan that overlap today (each with the status of
   its job), says whether the database offers the `btree_gist` extension, and applies nothing.
   - A visit that took place (its job is finished, its hour is past) is set to `COMPLETED`, which frees its hour; do not cancel it. For
     example `UPDATE "Appointment" SET "status" = 'COMPLETED' WHERE "id" = 123;`
   - A visit still to come is moved or cancelled from the dashboard.
   - A visit that still stands on a **cancelled** job (a job cancelled before a cancellation freed its visit) holds no hour. The dry run
     says how many there are and leaves them out of the pairs; `--apply` cancels them first, the way a cancellation does (the requests
     about them are closed, their reminders dropped). Cancelling such a job again from the dashboard does the same for one job.
5. When the dry run says it is ready, `npm run scheduling:constraints -- --apply` cancels those visits, then creates the `btree_gist`
   extension (the database user needs the right to create it; on a managed database it is often a setting of the provider) and the
   constraint. Run again, it finds the constraint and does nothing. Exit codes: 0 ready or applied, 1 overlaps remain or the extension
   is not offered (the constraint was not created), 2 error.

To take the constraint away: `ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_artisan_no_overlap";` (the code check stays).

A booking that loses a race against another is refused by the constraint and comes back as a 409 ("Ce créneau vient d’être pris").
Prisma's `db push` is not made to know the constraint: run it once on a copy of the database after the constraint is applied, to check
that your Prisma version leaves it in place, and run the script again after a push on a new database.

Visits left in "move requested" or "cancellation requested" with no request waiting (a refusal that could not restore them before this
change) are not repaired by anything. They are found with
`SELECT a."id", a."status" FROM "Appointment" a WHERE a."status" IN ('RESCHEDULE_REQUESTED', 'CANCEL_REQUESTED') AND NOT EXISTS (SELECT 1 FROM "AppointmentRequest" r WHERE r."appointmentId" = a."id" AND r."status" = 'PENDING');`
and set back by hand to `SCHEDULED` (or `CONFIRMED` when the artisan had confirmed).

A job is cancelled from the dashboard's cancellation (`PATCH /admin/interventions/:id/cancel`), by the customer, or by approving a
cancellation request. A status cannot cancel a job: `PATCH /interventions/:id/workflow/status` with the status `CANCELLED` is refused (400)
(so was `PATCH /interventions/:id`, deleted in P3-03), and the dashboard's `PATCH /admin/interventions/:id/status` was already. They wrote the status and
nothing else, so the artisan's hour stayed booked, no reminder was dropped and the back office was not told about money the job still
held. Saying `CANCELLED` again of a job that is cancelled already is let through.

Reminders go out at most once: a crash between taking a reminder and sending it loses that reminder rather than sending it twice.


## Who may do what, and the audit log (P3-02)

**One matrix says who may do what.** `src/common/auth/permissions.ts` is the only place that names roles against actions: 70
permissions (`users.manage`, `payments.refund`, `audit.read`...), each with the roles that hold it. A route says which one it needs with
`@RequirePermission(Permission.X)` and the guard `PermissionsGuard`; a service that has to decide in code asks `can(role, Permission.X)`
or `rolesWith(Permission.X)`. `@Roles` and `RolesGuard` are gone. To give a role a right, change one line of the matrix and nothing else;
`permissions.spec.ts` fails if a route names a permission nobody holds, if a role list comes back anywhere else, or if a route has a
permission but not the guard that checks it. The guard fails closed: a route that has `PermissionsGuard` and names no permission is
refused for everybody. `route-access.spec.ts` compares every route with a table written out in `route-access.golden.ts` (the roles of
each of the 330 routes), so a line of the matrix that widens or narrows a route shows up as a change of that file; the two are changed
together, on purpose. Two files that are copied into the shared package, and so import nothing (`staff-pages.ts`,
`intervention-status.ts`), keep their own copy of a role list: `permissions.spec.ts` fails when one differs from the matrix row it stands
for (the seven lists of `staff-pages.ts` and the staff list of the status rules).
The hierarchy (who may act on whom: `canManage`) is not a permission and stays in `role-policy.ts`.

What changed for somebody: the admin route that assigns a complaint (`PATCH /admin/complaints/:id/assign`) now accepts the same people as
the complaints module, which is support, dispatchers and admins (it refused dispatchers before), and it now refuses an assignee whose
account is switched off or deleted ('Agent support invalide.'). `PATCH /interventions/:id` answered 400 to an id that is not a whole
number (it used to turn it into `NaN`; the route was deleted in P3-03). Everything else keeps exactly the roles it had: the table in `route-access.golden.ts` was made from,
and checked against, the routes as they were before this step. To change who may call something, change the matrix **and** that table in
the same commit.

**Every write of the back office leaves a row in the audit log** (`AuditLog`): who (account and role), what (`clients.deactivate`), on what
(a type and an id), when (start and end), how it went. Only the back office is logged (a customer or a technician who calls the same
route leaves nothing), and only what gets past the guards: a refused call is not an action.

- The row is written **before** the action runs (`STARTED`) and closed after it (`SUCCEEDED`, or `FAILED` with the status of the error). If
  the row cannot be written, the action does **not** run: the answer is 503. If it cannot be closed, the action has happened and the
  answer is left alone; the row stays `STARTED`, like the row of an action that never came back (a crash). A closed row is never rewritten.
- The log keeps the **names** of the fields that were sent, and the **value** of a few that the action allows
  (`src/modules/audit/audit-actions.ts`: a status, a role, an amount, never a text typed by a person except a reason, cut at 200
  characters). A field that looks like a secret is never kept, whatever the list says. No address, no body, no token.
- `audit-actions.ts` lists every write route a back-office account can reach, with its action name and its target, and the routes that
  are left out on purpose (13) with the reason (read marks, push tokens, chat messages, position pings...). `audit-actions.spec.ts` reads the
  controllers: a new write route that is in neither list fails the build. A route that slips past anyway is logged as `unlisted`.
- `GET /api/admin/audit-log` (permission `audit.read`: admin and super admin) reads it, newest first:
  `?actorId=3&action=payments.&targetType=Payment&targetId=42&outcome=FAILED&from=2026-10-01&to=2026-10-31&limit=50&before=1200`.
  `action` is a name or an area ending with a dot; `before` is the `nextBefore` of the previous page. A day without an hour (`to=2026-10-31`)
  is the whole day in UTC; a date with an hour needs its zone; a day that does not exist, or a name the query does not know, is a 400.
  No screen reads it yet.
- Each database call of the interceptor is given 5 seconds (`interceptor.timeouts`). If the first row does not come in time, the action does
  not run (503; the row may still appear later as `STARTED`, with no action behind it). If closing the row takes longer, the answer goes out
  and the row stays `STARTED`. An id is a whole number written without leading zeros (`/users/0000042` is 42); a route that is given anything else (`0x2A`, `1e1`) leaves the target empty rather than wrong. The target types are one per id space: a technician's
  profile is `ArtisanProfile`, an account (a customer, or a technician seen from the cash ledger) is `User`.
- Not logged: reads, websocket events, calls refused by a guard, and a write by a customer or a technician. Also not logged, because nobody is
  signed in: the public routes that change an account (log in, `POST /auth/reset-password`, the email check, `POST /users/email-change/confirm`).
  The websocket event `artisan.location.update` lets a staff account write another technician's position; it was always so and is not logged
  (a position every few seconds would bury the log).
- There is no purge: the table grows with the work of the back office. Decide on a retention (and an archive) before it matters. Every
  call a back-office account makes to a write route is logged, also one that fails validation (400): one insert and one update each, with at
  most 50 field names. Reading a period (`from`/`to`) of a very large table sorts by id; if it gets slow, read by `before` pages, or add an
  index on `(createdAt, id)`.
- `outcome` is text (not a database enum) so the contract shared with the apps does not change in this step; make it an enum when a
  screen reads the log.

Order of the update: take a backup, `npx prisma generate && npx prisma db push` (a new table `AuditLog`; nothing else changes), then deploy
the new code right away. The new code writes to `AuditLog` before every back-office write, so a deploy on a database that has not had
`db push` refuses those writes (503) until it has.

## Legacy routes deleted (P3-03)

The first version of the API was copied by newer routes while the three screens were moved over (P1-13 to P1-16). This step deletes the
older copy of every route that **no screen calls any more** (found by reading the calls of the website, the dashboard and the phone app,
and of the shared client), and keeps the seven that one still does. Server only: the shared contract does not change.

**Deleted (23 routes), with what answers instead:**

| Deleted | Instead |
|---|---|
| `POST /interventions` (request form without an account) | `POST /guest/interventions` (visitor), `POST /client/interventions` (customer) |
| `GET /interventions`, `GET /interventions/:id` | `GET /client/interventions[/:id]`, `GET /admin/interventions[/:id]`, `GET /artisans/me/missions` |
| `PATCH /interventions/:id` | `POST /admin/interventions/:id/assign-artisan`, `/artisans/me/missions/:id/...`, `PATCH /interventions/:id/workflow/status` |
| `GET /interventions/track/:id`, `GET /public/tracking/:id`, `GET /interventions/public/:id/timeline` | `GET /guest/tracking/:id` |
| `PATCH /interventions/track/:id/feedback`, `POST /interventions/track/:id/issue` | `POST /guest/interventions/:id/feedback`, `POST /guest/interventions/:id/problems` |
| `GET /complaints/admin`, `GET /complaints/admin/dashboard` | `GET /admin/complaints` (and `GET /admin/dashboard/kpis`) |
| `PATCH /complaints/admin/:id/decision`, `PATCH /complaints/admin/:id/refund` | `PATCH /admin/complaints/:id/refund` for the money, `PATCH /admin/complaints/:id/close` to close; **not equivalent, see below** |
| `GET` and `PATCH /notification-preferences/me` (the whole module) | `GET` and `PATCH /notifications/preferences/me` |
| `POST`, `GET` `/messages/admin-notes/interventions/:id`, `DELETE /messages/admin-notes/:id` | `POST /admin/interventions/:id/internal-notes` (same table, but the accountant is refused there); the case file lists the notes; nothing deletes a note |
| `GET /services/admin`, `POST /services/categories`, `POST`, `PATCH`, `DELETE` `/services/sub-services[/:id]` | the same under `/services/admin/...`, with two differences: `GET /services/admin/categories` lists the inactive ones only with `?includeInactive=true` (the old route always did), and `DELETE /services/admin/sub-services/:id` deletes a sub-service that no job uses (the old `DELETE` only deactivated it; `PATCH .../:id/deactivate` does that) |

Gone with them: the service methods, the forms (`UpdateInterventionDto`, `SubmitFeedbackDto`, `ReportIssueDto`, `PublicTimelineQueryDto`, the two
complaint decision forms, `ComplaintQueryDto`), the filters of the complaints list that only `GET /complaints/admin` used (the staff list of
`GET /complaints/me` is the fifty newest, as it was), the bot check on the interventions module, the `userId` alias that the first strategy put next to `id` on `req.user`
(nothing reads it), and the two unused dependencies of the interventions service (the assignment and the mission service).

**Kept, because a screen still calls it** (`src/modules/interventions/legacy-routes.spec.ts` keeps this list and fails when it changes):

| Route | Screen | The screen has to move to |
|---|---|---|
| `POST /interventions/secure` | dashboard, "create a ticket" | a back-office route for creating a ticket on behalf of a customer (none yet) |
| `GET /interventions/assigned` | phone app, home and missions tabs | `GET /artisans/me/missions` (another answer: the mission board) |
| `GET /interventions/dashboard/stats` | dashboard home | `GET /admin/dashboard/kpis` (another answer) |
| `POST /interventions/:id/complete-work` | phone app, finish the job with a photo | `POST /interventions/:id/proofs/after`, then `PATCH /artisans/me/missions/:id/complete` (two calls) |
| `PATCH /complaints/admin/:id/{assign,status,resolve}` | dashboard, complaints page (shared client) | `PATCH /admin/complaints/:id/{assign,status,close}` |

The new routes do not answer exactly like the old ones, so each of these is a change of the screen, not a change of address.

**Before deploying, read the access log for one week.** The ticket's condition is that no screen and no other client (a script, a partner, a phone
app that is installed and old) calls a deleted path. A deleted path now answers 404 (the one exception: `GET /complaints/admin` is read as an id by
`GET /complaints/:id` and answers 400 to a signed-in account, 401 to anybody else). This search finds the requests to every deleted path and none to a route that stays (tried on sample lines of
the combined log format, with the request line in quotes as nginx and Apache write it, also with a trailing slash or capitals, which the
server serves too; change the path of the log):

```sh
zgrep -hiE '"(POST|GET) /api/interventions/?(\?[^ ]*)? HTTP|"(GET|PATCH) /api/interventions/[0-9]+/?(\?[^ ]*)? HTTP|/api/interventions/(track|public)/|/api/public/tracking/|/api/notification-preferences|/api/messages/admin-notes|"GET /api/complaints/admin(/dashboard)?/?(\?[^ ]*)? HTTP|/api/complaints/admin/[0-9]+/(decision|refund)|"GET /api/services/admin/?(\?[^ ]*)? HTTP|/api/services/categories|"POST /api/services/sub-services/?(\?[^ ]*)? HTTP|"(PATCH|DELETE) /api/services/sub-services/[0-9]+' /var/log/nginx/access.log* | head -50

# the same, counted by client (the last quoted field of the combined format)
zgrep -hiE '"(POST|GET) /api/interventions/?(\?[^ ]*)? HTTP|"(GET|PATCH) /api/interventions/[0-9]+/?(\?[^ ]*)? HTTP|/api/interventions/(track|public)/|/api/public/tracking/|/api/notification-preferences|/api/messages/admin-notes|"GET /api/complaints/admin(/dashboard)?/?(\?[^ ]*)? HTTP|/api/complaints/admin/[0-9]+/(decision|refund)|"GET /api/services/admin/?(\?[^ ]*)? HTTP|/api/services/categories|"POST /api/services/sub-services/?(\?[^ ]*)? HTTP|"(PATCH|DELETE) /api/services/sub-services/[0-9]+' /var/log/nginx/access.log* | awk -F'"' '{print $6}' | sort | uniq -c | sort -rn | head
```

(`POST /api/interventions/secure`, `GET /api/interventions/assigned`, `GET /api/interventions/dashboard/stats`, `POST /api/interventions/:id/complete-work`
and `GET /api/services/sub-services/:id` are not deleted and are not found.) A phone app installed before P1-15 may still use
`GET` or `PATCH /api/interventions/:id` for the missions: look at the client before deciding that it is nobody.

What changes for somebody, and what the replacements do not do:

- A note on a job can no longer be deleted through the API (no screen did; the case file only reads notes). Notes deleted before stay out of the
  case file and the complaint centre as before, but the back-office pages of an artisan, a client and a complaint (three readers in
  `admin.service.ts`) never looked at `deletedAt`, so a note deleted through the old route is still listed there.
- The accountant could read and write the notes of a job on the old routes; `POST /admin/interventions/:id/internal-notes` and the case file are for
  admin, super admin, support and dispatchers.
- The four deleted `/complaints/admin` routes were open at the door to every signed-in account, with the service refusing anyone who was not
  back office, so **any back-office role** (support and dispatchers too) could decide a refund on them; the replacements under `/admin/complaints`
  name their permission, and the refund is the finance roles' alone (accountant, admin, super admin). Nobody loses a thing a screen did.
- **The old complaint decision is not replaced one for one.** `PATCH /complaints/admin/:id/decision` recorded a verdict word (`adminDecision`),
  started or cancelled a refund request, closed the complaint when none was asked, and told the complainant. `PATCH /admin/complaints/:id/refund`
  records the refund decision and amount, a note and an event on the job, and **does not tell the complainant** (the old refund route did);
  `PATCH /admin/complaints/:id/close` takes a note and closes. **Nothing writes `adminDecision` and its note, author and date any more**: the
  columns stay (the verdict word is still sent to the customer and to the staff, the note, author and date to the staff) and are `null` on a new
  complaint. The kept `PATCH /complaints/admin/:id/resolve` is the only route that writes the text the customer reads (`resolutionNotes`);
  `close` writes no text and no `resolvedAt` (`PATCH .../status` with `RESOLVED` or `REFUNDED` stamps `resolvedAt` and `closedAt`, and so does the
  settlement of a refund), so the dashboard can move from `resolve` to `close` only after `close` is given that text.
- **Other replacements that do not do exactly what the route did:**
  - Status: `PATCH /interventions/:id/workflow/status` (the replacement named for the dropdown) sends no live event and no SMS to the customer;
    the dashboard's own `PATCH /admin/interventions/:id/status` does, and the deleted route did. An assignment through the old `PATCH` landed on
    "accepted" (`ACCEPTED`, shown as "affecté"); `POST /admin/interventions/:id/assign-artisan` lands on `ASSIGNED`.
  - Feedback: `POST /guest/interventions/:id/feedback` writes a review once and answers 409 to a second opinion (the old `PATCH` overwrote the
    rating), and has no limit per address (the old route allowed 20 an hour; the link is 64 hexadecimal characters and the service checks it).
  - Sub-services: `DELETE /services/admin/sub-services/:id` on a sub-service that a job uses deactivates it and answers a message, not the row.
  - Internal notes: `POST /admin/interventions/:id/internal-notes` cuts the length and answers the note with its author; the old route answered
    the raw row.
  - The board: `GET /artisans/me/missions` lists the open jobs with their whole row except the way to reach the customer (the matrix checks this
    now, as it did for the deleted `GET /interventions`); the rows carry three keys more than the deleted board copy did, `rating`, `isOnTime` and
    `cancelledAt`, which are empty on a job nobody finished.
- **No route edits the details of a job any more.** `PATCH /interventions/:id` also took the service type, the description, the address, the
  photos and the contact fields (and checked the catalogue); the admin routes assign, change the status, cancel, quote and note, and none of them
  writes these columns (the visitor can still add photos on `POST /guest/interventions/:id/photos`). Nobody's screen used the old route for this.
- `GET /complaints/me` (any back-office role) and `GET /complaints/:id` still return the raw complaints to every back-office role, with the
  e-mail and phone of the customer and of the assignee and the internal messages, **dispatchers included, who may not read `/admin/complaints`**
  (`complaints.read`). This is how it was; deleting `GET /complaints/admin` narrowed nothing there. For a decision in the audit tickets.
- The ticket also names the `artisan-applications` module: there is none at the base commit (applications go through `POST /artisans/apply` and
  `/admin/artisans`), so there was nothing to delete.
- The ticket also listed "artisan management" as a duplicate: the code has no older copy of the admin artisan routes, so nothing was deleted
  for it (`/admin/artisans/*` and `/users/artisans` are called by the dashboard).
- `intervention-status.ts` still says that the server refuses a problem report in a status where no artisan is on the job. That was the deleted
  route; `/guest/interventions/:id/problems` does not look at the status (only the website hides the button, and the limits of three reports a day
  and five complaints a job stay). The comment is copied into the shared package, so it is left for the next time the contract is regenerated.
- The shared client (`smart-depannage-shared/src/client.ts`, and its copy in the three screens) still has `routes.interventions.track`, which
  builds `GET /interventions/track/:id`. No screen uses it (the website uses `routes.guest.track`) and a call would answer 404; its test pins the
  URL. It goes with the next change of the shared package, which this step does not make.
- Left alone on purpose: `CreateInterventionDto` still accepts the three fields of the bot check (the secure route ignores them, so a client that
  sends them is not refused); `AssignmentService.assign` still accepts a landing status of `ARTISAN_ACCEPTED` (what the deleted dropdown route
  passed; no caller passes it now, and its tests stay); `businessClock` (`common/locale/business-time.ts`) has no caller left but its own test;
  and three comments in `intervention-status.ts` that say "legacy PATCH" (the file is copied into the shared package).
- `POST /interventions/secure`, which the dashboard's "create a ticket" calls, files the ticket under the staff member's own account and drops the
  contact name and phone the form asks for. It did before; with the public route gone it is the only way to create a ticket from the dashboard.

## Languages: French and Arabic (P3-04)

The product speaks French and Arabic (Modern Standard Arabic, short and plain). French is the source: every French text is what the server
always said, character for character. Arabic is read right to left; the apps draw the screens, the server decides the **language of what it
sends**. The admin dashboard stays French, and so does everything written to back-office staff.

**Order of the update.** Take a backup, then `npx prisma generate && npx prisma db push` **before** the new code runs: the step adds one column
(`User.locale`, text, `"fr"` for every existing row, nothing to migrate by hand), and the new code reads it with every query that reads a whole user row, so
on a database without it those queries fail (sign-in included). Then deploy the server, then the website and the phone app. The other order
works too for the apps: an old server ignores `X-App-Locale` and answers 404 to `PATCH /users/me/locale` (the app keeps the choice and tries
again), and the new server treats an old app (no header) as French.

**Where the language comes from**

- `User.locale` (`"fr"` or `"ar"`, text, `"fr"` by default; `npx prisma db push` adds the column). A customer or a technician chooses it in the
  website (the language switch) or the phone app (the profile); the app tells the server with `PATCH /users/me/locale  { "locale": "ar" }`, which
  writes that one column and answers `{ locale }`. `GET /users/me` and the sign-in answers carry it, so an app that signs in on a new phone shows
  the language the person chose.
- The header `X-App-Locale: fr|ar` is sent by the website and the phone app on every call. The server reads it (`requestLocale`, `declaredLocale`;
  a region or a capital letter does not matter, `en` or nothing is "no header"). **The dashboard never sends it, so it always gets French.**
- `recipientLocale(user, requestLocale?)` is the one rule for "which language do I write to this person in": staff (admin, super admin, support,
  dispatcher, accountant) are always **French**; a customer or technician gets their `locale`; an account with no usable `locale` gets French;
  nobody known (a visitor with no account) gets the language of the request. The language of a request never overrides an account's own choice.
- A visitor with no account: the guest profile keeps the language the website showed when the request was made (`createGuestIntervention`),
  and the tracking link and the activation code are written in it. A visitor who asks again in another language is written to in that one. (Known limit: a guest profile is found by its phone number, so a request that
  gives somebody else's number with another language changes the language of that profile's next messages; the owner's next request changes it back.
  Nothing else of the profile changes, and the same request could already make the platform text that number.)
  Asking for an activation code does **not** change the profile language (it proves nothing); the code and the link that follow are in the
  language of the page, falling back to the profile's.
- Registration (`POST /auth/register`) opens the account in the language of the request. A technician's application keeps the language it was made
  in, and the invitation sent when it is approved is written in it.

**The texts** (`src/common/i18n`)

- `i18n.ts` is the small formatter shared with the apps (it is copied into the shared package by the contract generator): `{name}` values and
  `{count, plural, ...}` with the Arabic forms (zero, one, two, few, many, other) and `=N`. `#`, `<`, `>` and the straight apostrophe are not part of
  the syntax; a test rejects them.
- `messages/` holds **every text sent to a customer, a visitor or a technician** as a pair `{ fr, ar, isolate }`, grouped by area (auth, guest,
  mission, quote, payment, invoice, appointment, complaint, chat, application). Use `say(MESSAGES.area.key, locale, { values })`. `isolate` names
  the values that are Latin letters or digits (a name, an address, an amount, a request number, a code): in Arabic they are wrapped in
  direction isolates so that the right-to-left sentence does not reorder them; in French nothing is added. **A link is deliberately not isolated**
  (a message app that makes a link tappable could take the invisible mark into the address, or into a one-time token); it stays on a line of its own
  or after a colon. `moneyIn` and `whenIn` write an amount and a moment for each language.
- `messages.fr-pins.spec.ts` pins the French of every message to the wording that existed before this step; `messages.spec.ts` checks that every
  message has both languages and the same values in both, that an Arabic text has Arabic letters and Arabic punctuation, that it does not use the
  words the glossary forbids for the customer, the technician and the job, and that no link is isolated.
- Messages to back-office staff (the staff notices, the alert SMS, the internal notes) are **not** in `messages/` and stay French. A text that a
  person typed (a note, a description, a name) is sent as typed.

**Notifications and templates**

- A notification is written in its recipient's language at the moment it is made (`recipientLocale`), and a text message that falls back from a
  push is rendered again in the same language. A push, an SMS and an e-mail of one event are in one language.
- The templates an administrator writes in the table of templates are French and keep their keys. The Arabic version of a message is another row
  whose key is `<key>@ar` (`QUOTE_SENT.SMS@ar`, `guest.tracking_sms@ar`). A message to somebody who reads Arabic looks for that row only; when it is
  missing, inactive, of another type, or has lost its code or link, the built-in Arabic text is sent. The French template is never used for
  Arabic, and the two are never mixed. There is no screen for the `@ar` rows yet; they are created through the existing template route.

**Refusals (the sentence of an error)**

- The services throw French sentences (`throw new ConflictException('...')`). `I18nExceptionFilter` (`APP_FILTER`) gives the body of the answer in
  Arabic when the request says `X-App-Locale: ar`, from the dictionary `errors/errors.ar.ts`: the key is the French sentence with `{}` where a value
  goes, the Arabic text uses `{1}`, `{2}` for them. A sentence the dictionary does not know stays French, so a missing entry is never a failure.
  Without the header the body is the one Nest would have sent (same object, same status). A translation error never turns a refusal into a 500.
- `errors.coverage.spec.ts` scans the source for every sentence thrown in an `HttpException` and fails when one is not in the dictionary or has the
  wrong values, so a new refusal must get its Arabic in the same change.

**Tests that keep this honest:** `i18n.format.spec.ts` (the formatter and the plural forms), `request-locale.spec.ts`, `messages/*.spec.ts`,
`errors/*.spec.ts`, and one `*.locale.spec.ts` beside each service that sends a message (users, auth, guest, invoices, assignment, artisans,
notifications, admin).

**Not done here / to know**

- A technician who was signed in before this step has `locale = "fr"` on the server until they open the profile, pick a language, or sign in again
  (the app tells the server then). The server cannot tell a French default from a French choice.
- The Arabic of the messages needs a reader whose first language it is before it is relied on; the glossary decisions are listed in the plan.
- An Arabic text message with a link is two or more SMS segments (Arabic is sent in UCS-2: 70 characters for one segment).
- A text typed by a person, and the names of the services and trades in the database, are not translated.

## Technician position: history, stale flag, arrival time, route replay (P3-05)

The phone of a technician says where it is; the server keeps the **last position with the time it was sent**, keeps a **history of positions for a few
days**, tells the dispatcher when a technician has **gone quiet**, tells the customer **when the technician will be there**, and can **replay the route**
of a job when there is a dispute.

**Order of the update.** Take a backup, then `npx prisma generate && npx prisma db push` **before** the new code runs: the step adds one column
(`User.positionAt`, empty for every existing row) and one table (`ArtisanLocationPing`). The new code reads `positionAt` with every query that reads a
whole user row, so on a database without it those queries fail. Then deploy the server, then the website, the dashboard and the phone app. An old
phone app keeps working (it sends no extra fields); it only sends a position while it is open, as before.

**Settings** (both optional; a value that is not a whole number in its range is ignored and the default is used)

| Variable | Meaning | Range | Default |
| --- | --- | --- | --- |
| `LOCATION_STALE_MINUTES` | silence after which a position is called stale | 2 to 120 | 10 |
| `LOCATION_HISTORY_DAYS` | days the history of positions is kept | 1 to 90 | 7 |

The rules are in `src/common/geo/location-rules.ts` (pure functions, one spec pins each number).

**What is written, and where**

- Three places write a technician's position, and **all three ask `planPing` (`modules/locations/ping-plan.ts`) first**: `PATCH /artisans/me/location`
  (the phone), the socket event `updateArtisanLocation` (the phone, live) and `PATCH /users/location` (the older general route). The plan checks the point
  (finite numbers, inside the ranges, **not 0,0**, which is what a phone reports when it has no reading: refused with "Position invalide."), gives the
  time (`positionAt`), and says which row to add to the history. The caller writes the position, the time, `lastSeenAt` and the row **in one
  transaction** (the two REST routes and the socket). The phone's position on `PATCH /artisans/me/location` loads only the id of the profile.
  `locations.write-sites.spec.ts` fails if any other code writes the coordinates of a user.
- **A history row exists only for a position sent on a job** that is on the way, arrived or at work (the job named by the phone if it is theirs and at
  one of those stages; otherwise the one on the way, then the one arrived, then the one at work, the latest first). A position sent while waiting or on
  the way home has its time and no row: nothing replays it, so nothing keeps it.
- A row is added only if the **last row of that technician, whatever its job, is not less than 10 seconds old**; the current position and its time are
  updated every time. A phone that reports every second, or names two jobs by turns, does not fill the table. (There is no rate limit per user on the
  position routes besides this; the guard is per IP.)
- Two positions of one technician that are in flight together can both pass the 10-second check and add two rows, and the one that was sent first can be
  written last and move the position back by a few seconds. Both are harmless for a route and a flag; they are known, not guarded.
- The socket reads latitude and longitude as numbers (or as a text that holds one): `null`, an empty text or a list is **not** read as 0. The accuracy,
  speed and heading sent on to the customer's room are checked like the ones stored.
- **A position sent over the socket by the staff** (a dispatcher moving a dot for a technician) is written without a time (`positionAt` is emptied, so the
  coordinates are `unknown`, never fresh), with no `lastSeenAt` and no history row. The phone did not say it, so it must not make the technician look reachable
  and must not enter the route that is replayed for a dispute. (No client sends this event today.)
- `lastSeenAt` is the last sign of life of any kind (the online switch counts); `positionAt` is the age of the **position**. The flags use `positionAt`.

**Stale, fresh, unknown**

- A position is **fresh** when its news is less than `LOCATION_STALE_MINUTES` old, **stale** from that silence on (the limit itself is stale), and
  **unknown** when nobody knows when it was sent (a position written before this step has no time, until the technician's next ping).
- Read-time flags (`locationState`: `fresh|stale|unknown`, `locationAgeMinutes`): the technicians list (`GET /users/artisans`, which also carries
  `artisanProfile.availabilityStatus` and `hasJobUnderWay` (a job on the way, arrived or at work: one extra read per page, for the ids of the page) so that "no news" is shown only for a technician who is active and at work
  or on a job: the dashboard flags nobody who is offline with no job, because that phone sends nothing), the location of one technician
  (`GET /admin/artisans/:profileId/location`, with `positionAt`) and the candidates of the matching. **The matching score is not changed by the flag**: it is for
  the dispatcher to weigh, not a hidden penalty. That includes `POST /matching/admin/interventions/:id/assign-best`, which takes the first candidate with
  nobody reading the flag: a technician who has been silent for hours and was last near the job can still win on distance. Nothing is pushed to the
  dispatcher when a technician goes quiet; the flag is seen when the list is open.

**Arrival time** (`arrival` next to the job, for the customer `GET /client/interventions/:id` and the tracking link `GET /guest/tracking/:id?token=...`)

- Only while the job is **on the way** (the same stage as the position that is shared), and only with a **fresh** position and a job that has a point on
  the map: `{ state: 'fresh', minutes, ageMinutes }`. Otherwise `minutes` is null and `state` says why: `stale`, `unknown` or `no-destination`. The
  customer is never given a time worked out from an old position.
- **The point of a job.** A request made from a **saved address that has a point on the map** gets that point when the request carries none of its own
  (`ClientInterventionsService.create`), so the time and the route measure to it. Jobs created before this step from a saved address stay without a point
  (no back-fill was written): they show `no-destination`. The point belongs to the text of the address: `ClientAddressesService.update` clears it when the
  `address` or `city` changes and no new point is sent (the same text sent again keeps it, and a city that was never given and an empty one are the same text), so an edited address is never measured to its old place.
  A latitude sent without a longitude (or the reverse) is stored as sent, as before this step: the point is then half new; no screen sends that today.
- **The coordinates follow the same rule**: the customer and the tracking-link holder get `artisan.latitude/longitude` while the job is on the way **and
  the position is fresh**; an old or undated one is not served at all (the website does not read them).
- It is the straight line between the two points, made longer by a road factor (1.3) and divided by an average speed (30 km/h), rounded up, at least one
  minute. These two numbers are assumptions, not a measure: there is no routing service behind them, and they are constants in `location-rules.ts`.
  Most requests made on the website have **no point on the map**, so they show the state `no-destination` and no time.
- `arrival` is computed outside the view of the job (`withArrival` in `common/views`): the view is what the contract of the apps is read from, and a
  value with a time in it cannot be.

**Retention** (`modules/locations/history-purge.ts`, run once a day from 03:30 in the business time zone, **Africa/Tunis** unless `BUSINESS_TIMEZONE` or the company settings say otherwise, by `history-purge.service.ts`)

- The service is asked every 15 minutes (`@Cron('*/15 * * * *')`, on a method that takes no argument: `run()`, which gives `tick` the time) and runs the round at the first ask inside the
  window **03:30 to 05:59 there**, once per local date (`purgeSlot`). A window, not a minute: a server that was restarting at 03:30 (a deploy at that hour) or a database that was away does
  not lose the day, the next ask tries again; the day is marked done only when the round succeeded, a failed round is written to the log and retried at the next ask of the window.
  The zone is read at the moment of asking, because the company settings are read after the server starts, and the machine's own zone does not matter. A restart after a successful
  round, inside the window, runs it a second time (a delete of rows that are gone deletes nothing). **The way `@Cron` reads its options has not been run against the real
  scheduler in this environment**; look at the log the morning after the first deploy (it writes how many rows it deleted when it deleted any).

- Rows older than `LOCATION_HISTORY_DAYS` are deleted in batches of 5,000 (at most 200 batches a night; a night that stops at its limit with rows left
  writes a warning in the log and the rest goes the next night). **A job with an open complaint, or in the DISPUTED
  status, keeps its rows** until the complaint is closed; they are deleted by the next night's run after that. A dispute raised **after** the retention has
  passed finds the route already gone (the replay says so, see `mayBeIncomplete`).
- Known limits of the round: the jobs it keeps are passed to the delete as a list (`notIn`), which a database refuses beyond about 32,000 held jobs (the held jobs are read once per round); this does not matter at the size of this business,
  it would at a very large one.

**Route replay** (`GET /admin/interventions/:id/route`, permission `location.history`: admin, super admin, support, dispatcher)

- **A route is one technician's.** A job can change hands (the technician gives it back, the staff hands it to another). The route is the one of the
  technician who holds the job now, or, when nobody holds it, of the one who sent the latest position on it; `artisan.current` says which. The other
  technicians who sent positions on the job are listed in `others` (name, how many, from when to when) and are read with `?artisanId=`. A technician who
  is neither the one of the job nor anywhere in its positions is a **404**, as is a number below 1 or beyond what the database can hold (something that is not a number at all is refused with a 400).
- Returns the points of the job in time order (at most 2,000; beyond that the answer stops there and `cut` is true: **the latest positions are then
  not in it**), the destination, the technician's name, the moments of the job (on the way, arrived, work started, work completed), and a summary:
  the length of the route in km, the closest the technician came to the destination (metres) and when, and the distance at the moment of "arrived"
  (the position nearest in time, within 5 minutes).
- **The moments are the job's own dates** (`artisanOnTheWayAt`, `artisanArrivedAt`, `workStartedAt`, `workCompletedAt`), written in the same transaction as
  the status, not the lines of the timeline (which are written afterwards and may be missing). They belong to the technician who holds the job: the route
  of one who gave it back has none. `mayBeIncomplete` is true when the **earliest** moment of the holder is longer ago than `LOCATION_HISTORY_DAYS`: the first positions
  may already have been deleted. With no moment (the route of a technician who no longer holds the job, or a holder who has not set out) the date the job was created is used
  instead, so the note can appear for a job that is old but whose technician's route is recent: it is cautious, never the other way round.
- The length of the route adds every segment, including the small jumps of a GPS that stands still after the arrival (a few metres every 30 seconds): it reads **longer than
  the road**. When the points are cut at 2,000 the summary is computed from those 2,000 (the first ones), and the dashboard says so next to the figures.
- **Reading a route is not audited** (the audit log keeps writes only); the route of a job is personal data of the technician and the permission is the
  only guard. Whether reads should be logged is an open decision.

**Not done here / to know**

- **The phone sends its position only while the app is open**, about every 30 seconds while the technician is online. Background tracking needs the
  operating system's "always" permission, a new native build and the stores' approval of the reason; it is an owner decision and is not done. A phone in the
  pocket with the app closed is stale after the limit, which is the expected reading.
- The privacy notice for technicians, and the wording of the permission request, are a business decision.
- The older socket event `sendPosition` (`interventions.gateway.ts`, a relay to the staff room) writes nothing and is not part of the history.
- The Arabic wording of the new tracking texts needs a reader whose first language it is, as for the rest of P3-04.

## Actions the phone kept until it had a signal (P3-06)

The technician's phone keeps the three steps of the road (on the way, arrived, start) and the photo that closes the job when it has no network, and sends them
in order when the network is back. The server only sees them arrive late. So that a late arrival is not taken for a late action, the phone adds one header to
each of those calls:

`X-Queued-For: <seconds>` — how long the phone held this action, counted on its own clock (the difference of two readings of the same clock does not depend on
the clock being right).

It is read on `PATCH /artisans/me/missions/:id/on-the-way`, `/arrived`, `/start` and on `POST /interventions/:id/complete-work` (the photo that closes the job), and nowhere else:
the phone keeps nothing but those four, so the route of the before / after photos (`POST /interventions/:id/proofs/:kind`) ignores it.
**Nothing else changes**: a call without the header is dated at its arrival, as before; an old phone works with this server and a new phone with an old one
(an unknown header is ignored).

- **The action is dated at its arrival minus that figure** (`src/common/time/queued-for.ts`): `artisanOnTheWayAt`, `artisanArrivedAt`, `workStartedAt`, and for a photo
  `workCompletedAt` and `afterPhotoAt` (the figure is read for the photo that closes the job only, never for a before photo). Two things hold it in place: it is never dated **before an earlier moment of the same job** (arrived is
  not dated before on the way; the job's own dates are read for that: acceptance, set off, arrival, start of work, and also its assignment and its making, for the
  short roads where a job is assigned as accepted or goes from assigned straight to the work) and never **after its arrival**. A figure that is missing, empty, negative, fractional, in
  another notation, two values ("5, 7") or more than 12 digits counts as 0; one above 7 days (up to 12 digits) counts as 7 days.
- **The time of arrival is still kept** where the server keeps one: `ProofCapture.receivedAt` is the arrival, `clientCapturedAt` is what the phone said. The timeline
  (`InterventionEvent.createdAt`) is the time the server wrote the line, so a queue sent after a long silence shows its lines together and in order, while the
  dates of the job (and so the route replay, which reads those) show when the technician pressed.
- **The clock check of a photo** compares the phone's clock with the server's at the time the photo was taken, that is the arrival minus the figure, **and never before the
  work began** (the same date the job is closed at). A photo held for four hours is no longer sent to the review queue as "the phone's clock is four hours wrong"
  (`CLOCK_DIFFERENCE`); a phone whose clock really is wrong is still caught, by the same 15 minutes; and a phone cannot claim a hold longer than the job's own history to make an old
  picture pass for a recent one (a picture older than the work is sent to review).
- **A figure is a claim, bounded.** A technician can say "held for 7 days" and have a step dated up to 7 days back, but never before the step that came before it, so the
  order of the road cannot be rewritten, and no step can be dated before the job was assigned (or made). It is not a way to be somewhere you were not (a photo is still judged on
  its position, its accuracy and its picture).
- **A repeat is safe.** A step sent again after a lost answer finds the job already there: nothing is written, nobody is told twice, the first date stays (this was already so,
  P1-06). A completion sent for a job that is already past the work is a **409** whatever the status (a job moved on by staff to "waiting for the customer" included, which the technician can only leave by raising a dispute;
  the phone then reads the job and counts its photo as sent; a job in dispute is not counted as done by the phone, which tells the server's sentence). A completion sent again after a lost answer is a **409 "already closed"** (also when the first try commits while the second one is being checked: the job is looked at once more before the photo is called "already used"); the phone reads the job and, when it is closed, counts its photo as sent.

**Limits**: the timeline lines and the messages to the customer and to the staff are those of the arrival (the customer is told "on the way" when the phone sends it, not when it was
pressed). Accepting and handing a job back are not held by the phone (they need the server's answer: another technician may have taken the job).

## One job offered to the best technicians, first to accept wins (P3-07)

The back office can offer an **open** job (waiting for a technician: `CREATED`, `WAITING_ADMIN_REVIEW` or `QUOTE_ACCEPTED`) to the best-matched technicians who are
free for it, at the same time, for a few minutes. Each gets a push and sees the offer in the app with a countdown. **The first to accept gets the job; the others
see the offer withdrawn.** Offers are an extra layer on the one existing path: accepting is still `POST /artisans/me/missions/:id/accept`.

| Route | Who | What |
| --- | --- | --- |
| `POST /api/admin/interventions/:id/offers` | `tickets.dispatch` (admin, dispatcher) | Makes a round. Body (both optional): `count` (1 to 10, default `OFFER_COUNT` = 5), `minutes` (1 to 120, default `OFFER_MINUTES` = 10). Takes the best matches that are free (the list and score of "assign the best"), leaves out those whose trade does not fit and those who were already asked for this job. Answers `{ round, expiresAt, asked, offered, offers: [{ id, artisanId, name, rank, score, expiresAt }] }`. |
| `GET /api/admin/interventions/:id/offers` | `tickets.read` | Every offer of the job by round and rank, with the technician's name and score, each read as `open`, `accepted`, `declined`, `expired` or `withdrawn` (and why). |
| `DELETE /api/admin/interventions/:id/offers` | `tickets.dispatch` | Calls the round off: every live offer is withdrawn (`STAFF`) and each technician is told live. |
| `GET /api/artisans/me/offers` | `missions.work` (technician) | The technician's own offers: the ones to answer now (soonest to run out first), then those offered in the last 24 hours that have ended, with `now` (the server's clock, for the countdown). An open offer carries the job as the board shows it (no way to reach the customer); an ended one carries only its trade. |
| `GET /api/artisans/me/missions/:id` | technician | Gains `offer` (the technician's own offer of the job, or `null`). |

**How the atomic part works.** The accept runs under the advisory lock of the job and takes the job with one compare-and-set on its status. Only when that claim changed
the job, in the same transaction, the winner's offer becomes `ACCEPTED` and every other offer still waiting becomes `WITHDRAWN` (reason `TAKEN`). A losing accept finds the
job taken and is answered with the usual 409. Offers that had already run out but were not yet swept become `EXPIRED`, not `WITHDRAWN`: nobody is told a job was taken from under
them. Giving the job to a technician (assign, assign the best, the planning) ends the offers in the transaction of the assignment (`ASSIGNED`). A job that is cancelled or moved on by another route is caught by the sweep within a minute (`CANCELLED` for a cancelled job, `TAKEN` for a job a technician holds, no reason for any other job that left the queue, such as a quote sent, which the app reads as "no longer available"); until then every read (the technician's list, the details, the back office's list) already calls its offers withdrawn, and an accept is refused because the job is not open.

**The rows agree with who holds the job.** Whoever ends up holding the job has the accepted offer: if the back office gives the job to a technician whose offer had been withdrawn as taken, or a technician takes it from the board after their offer ran out, their offer becomes `ACCEPTED`; the offer of the technician who held it before (accepted) becomes `WITHDRAWN` (`TAKEN` or `ASSIGNED`), or `DECLINED` when that technician gave the job back themselves. A technician who was not offered a job that is reserved for others cannot refuse it either (409): the refusal would be written down against a job they never saw.

**Reservation.** While any offer of a job is live (`PENDING` and not past `expiresAt`), the job is reserved for the technicians it was offered to: the board leaves it out for the others, its
details are a 403 ("not assigned to you") and accepting it by number is a 409 ("offered to other artisans for a few minutes"). When no offer is live any more the job is open to every
technician it fits, exactly as before offers existed. Reads judge an offer against the job and the clock, not only against the stored status, because the sweep runs once a minute.

**The sweep** (`@Cron` every minute): writes `EXPIRED` for offers past their time (and tells the technician live), writes `WITHDRAWN` for offers of a job that is no longer open
(a safety net: the routes above end offers themselves), and tells the dispatching staff in French when the last live offer of a still-open job ran out ("Offre restée sans réponse"). Every
write is "only if still waiting", so an answer given at the same moment wins. An offered technician who holds the job through a route that does not settle offers has their offer written as accepted, not withdrawn. A round is reported to the staff only once no offer of it is left waiting (so a sweep that failed half way does not report it early).

**Live events and push.** Push type `MISSION_OFFERED` (`interventionId` + `data { offerId, expiresAt }`; the push opens the offer screen of the phone app, not the mission screen: the job is not theirs until they accept). The live event `mission.offer.updated`
`{ interventionId, status: 'withdrawn' | 'expired', because? }` goes to the technician's open apps; nothing is stored for it (the offers list is the truth).

**Deploying**: `prisma generate && prisma db push` (new table `MissionOffer`, two enums, one new `NotificationType` value). Settings `OFFER_MINUTES` and `OFFER_COUNT` are optional; a value out of range is ignored.

**Limits**
- There is no dashboard button and no automatic trigger yet: a round is made through the API (the dashboard and an automatic first round come later).
- One offer per job and technician (a unique key): a technician whose offer ran out, was withdrawn (another technician took the job and then gave it back, say) or was declined is not asked again for the same job; a later round asks others.
- An offer reserves the job until it ends, even when its technician can no longer take it (at their maximum of active jobs, switched off, suspended): the other technicians see the job again at the latest when the offer runs out (10 minutes by default), or at once when the staff call the round off (`DELETE .../offers`). Suspending a technician does not withdraw their offers.
- Quiet ends send the staff no notice: a technician who answers after the deadline, a round in which every technician declines. The staff notice for a round that ran out is sent by the process that sweeps; with more than one server process it can be sent twice.
- The sweep takes the 500 oldest live offers in one pass (the writes of offers that ran out are done first); with more than 500 live offers at once the end of an offer of a job that left the queue can wait for the next pass. Reads are right in the meantime.
- Routes that move a job out of the queue without going through the assignment (cancelling, sending a quote, the older status route) leave the offers to the sweep; a job that comes back to the queue before the sweep wrote its end has its still-live offers reserving it again.
- Staff can give a job to a technician at any time, also one a technician has just accepted from an offer, unless the screen sends the technician it showed (`expectedArtisanId`); the rows then agree with the new holder.
- The staff notice "Offre restée sans réponse" is sent when the sweep writes the end of the last offer of a job that is still open as *run out*. A round whose last live offer ends by a refusal (every technician declines, or one lets the time run out and the others decline) is not reported; the staff see it in `GET .../offers`. Until the sweep has written it, a cancelled job or a job another technician holds reads as "no longer available" in the technician's list (the sweep then says why).
- An offered technician who holds the job through a route that does not settle offers, and whose own offer runs out in the very minute the sweep looks at it, has that offer written as run out (the expiry is written first and the check of closed jobs only looks at offers still in time); their list then says "ran out" for a job they hold. The case needs a route that gives a job without settling offers and an offer ending in the same minute.
- The withdrawal is told live only to apps that are open; the phone has no socket yet, so it learns on its next refresh or when it tries to accept (409).
- Offers are not shown in the dashboard's case file, and they are not part of the audit log beyond the two staff writes (`interventions.offer-to-artisans`, `interventions.withdraw-offers`).
