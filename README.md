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
cancellation request. A status cannot cancel a job: `PATCH /interventions/:id` and `PATCH /interventions/:id/workflow/status` with the
status `CANCELLED` are refused (400), and the dashboard's `PATCH /admin/interventions/:id/status` was already. They wrote the status and
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
account is switched off or deleted ('Agent support invalide.'). `PATCH /interventions/:id` answers 400 to an id that is not a whole
number (it used to turn it into `NaN`). Everything else keeps exactly the roles it had: the table in `route-access.golden.ts` was made from,
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
- `audit-actions.ts` lists every write route a back-office account can reach, with its action name and its target, and the 14 routes that
  are left out on purpose with the reason (read marks, push tokens, chat messages, position pings...). `audit-actions.spec.ts` reads the
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
