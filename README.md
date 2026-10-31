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
