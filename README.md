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
