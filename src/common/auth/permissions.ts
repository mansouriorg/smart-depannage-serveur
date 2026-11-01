import { Role } from '../../../generated/prisma/client';

/**
 * Who may do what: the one table of the server (P3-02).
 *
 * Before, every route listed its roles in an `@Roles(...)` of its own, and the services repeated the lists
 * (who is told about money, who may verify a document, who sees every job...). The same sentence was written
 * in a hundred places and could be written differently in each. Now a route names what it does
 * (`@RequirePermission(Permission.PAYMENTS_REFUND)`), a service asks `can(role, Permission.X)` or
 * `rolesWith(Permission.X)`, and THIS table says which roles hold which permission. To change who may refund a
 * payment, change one line here.
 *
 * Reading it: every permission has one line with the roles that hold it, in the order of the `Role` enum.
 * A super administrator holds every permission except the six that are personal to a technician or a customer
 * (`artisan.presence`, `cash.collect`, `invoices.mine`, `missions.work`, `payments.pay`, `quotes.respond`); an
 * administrator holds the same minus `staff.create` and `notifications.edit-any`.
 *
 * It decides WHICH KIND of account may call a route. Whether this customer may see this job, or this
 * technician this mission, is still decided by the service from the rows (ownership), and a staff role can
 * still be refused by the hierarchy (`canManage`: an administrator cannot touch a super administrator).
 * `permissions.spec.ts` reads the controllers and fails when a route has no permission or names one that does
 * not exist; `route-access.spec.ts` fails when who may call any route (the permission it names, and the roles that
 * hold it) differs from the table written out in `route-access.golden.ts`.
 *
 * Nothing here reads the database or `process`.
 */

export const Permission = {
  // Back office
  BACK_OFFICE_ACCESS: 'back-office.access',
  DASHBOARD_KPIS: 'dashboard.kpis',
  AUDIT_READ: 'audit.read',
  // Accounts
  USERS_MANAGE: 'users.manage',
  USERS_READ: 'users.read',
  USERS_LIST_ARTISANS: 'users.list-artisans',
  STAFF_CREATE: 'staff.create',
  LOCATION_REPORT: 'location.report',
  CLIENTS_READ: 'clients.read',
  CLIENTS_EDIT: 'clients.edit',
  CLIENTS_DEACTIVATE: 'clients.deactivate',
  NOTES_WRITE: 'notes.write',
  // Technicians
  ARTISANS_MANAGE: 'artisans.manage',
  ARTISANS_REVIEW: 'artisans.review',
  ARTISANS_ACTIVITY: 'artisans.activity',
  LOCATION_HISTORY: 'location.history',
  // Jobs
  TICKETS_READ: 'tickets.read',
  TICKETS_NOTE: 'tickets.note',
  TICKETS_DISPATCH: 'tickets.dispatch',
  TICKETS_WORKFLOW: 'tickets.workflow',
  WORKFLOW_NEXT_STATUSES: 'workflow.next-statuses',
  WORKFLOW_TIMELINE: 'workflow.timeline',
  PROOFS_ADD: 'proofs.add',
  PROOFS_REVIEW: 'proofs.review',
  MISSIONS_WORK: 'missions.work',
  ARTISAN_PRESENCE: 'artisan.presence',
  ARTISAN_PROFILE: 'artisan.profile',
  CLIENT_ADDRESSES: 'client.addresses',
  CLIENT_REQUESTS: 'client.requests',
  // Complaints
  COMPLAINTS_READ: 'complaints.read',
  COMPLAINTS_HANDLE: 'complaints.handle',
  COMPLAINTS_REFUND: 'complaints.refund',
  COMPLAINTS_ASSIGNEE: 'complaints.assignee',
  // Money
  FINANCE_READ: 'finance.read',
  COMPANY_READ: 'company.read',
  CASH_READ: 'cash.read',
  CASH_WRITE: 'cash.write',
  CASH_COLLECT: 'cash.collect',
  PAYMENTS_HANDLE: 'payments.handle',
  PAYMENTS_REFUND: 'payments.refund',
  PAYMENTS_EDIT: 'payments.edit',
  PAYMENTS_CHECK: 'payments.check',
  PAYMENTS_RECEIPT: 'payments.receipt',
  PAYMENTS_PAY: 'payments.pay',
  INVOICES_ISSUE: 'invoices.issue',
  INVOICES_VOID: 'invoices.void',
  INVOICES_EXPORT: 'invoices.export',
  INVOICES_VIEW: 'invoices.view',
  INVOICES_MINE: 'invoices.mine',
  // Quotes
  QUOTES_WRITE: 'quotes.write',
  QUOTES_EXPIRE: 'quotes.expire',
  QUOTES_READ: 'quotes.read',
  QUOTES_FOR_JOB: 'quotes.for-job',
  QUOTES_RESPOND: 'quotes.respond',
  // Files
  FILES_USE: 'files.use',
  FILES_VISIBILITY: 'files.visibility',
  FILES_DAMAGE_PHOTO: 'files.damage-photo',
  FILES_ARTISAN_DOCS: 'files.artisan-docs',
  FILES_QUOTE_PDF: 'files.quote-pdf',
  FILES_INVOICE_PDF: 'files.invoice-pdf',
  FILES_COMPLAINT_ATTACHMENT: 'files.complaint-attachment',
  // Settings
  NOTIFICATIONS_OWN: 'notifications.own',
  NOTIFICATIONS_MANAGE: 'notifications.manage',
  NOTIFICATIONS_EDIT_ANY: 'notifications.edit-any',
  SETTINGS_READ: 'settings.read',
  SETTINGS_MANAGE: 'settings.manage',
  CATALOG_READ_ADMIN: 'catalog.read-admin',
  CATALOG_MANAGE: 'catalog.manage',
  // Notices
  NOTICES_MONEY: 'notices.money',
  NOTICES_SUPPORT: 'notices.support',
  NOTICES_DISPATCH: 'notices.dispatch',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const { CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT } = Role;

/** The matrix: for each permission, the roles that hold it. */
const TABLE: Record<Permission, Role[]> = {
  // ---- Back office
  /** Work in the back office at all: every staff account. Every write made by such an account is written in the audit log. */
  [Permission.BACK_OFFICE_ACCESS]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Read the figures of the dashboard. */
  [Permission.DASHBOARD_KPIS]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Read the audit log of the back office. */
  [Permission.AUDIT_READ]: [ADMIN, SUPER_ADMIN],
  // ---- Accounts
  /** Create, edit, deactivate and reactivate accounts; send a password-setup link. */
  [Permission.USERS_MANAGE]: [ADMIN, SUPER_ADMIN],
  /** Read the directory of accounts. */
  [Permission.USERS_READ]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** List the technicians (to give them jobs). */
  [Permission.USERS_LIST_ARTISANS]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Create a staff account. Only a super administrator. */
  [Permission.STAFF_CREATE]: [SUPER_ADMIN],
  /** Send one’s own position. */
  [Permission.LOCATION_REPORT]: [ARTISAN, ADMIN, SUPER_ADMIN],
  /** Read the customers (back office). */
  [Permission.CLIENTS_READ]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Edit a customer’s details. */
  [Permission.CLIENTS_EDIT]: [ADMIN, SUPER_ADMIN, SUPPORT],
  /** Deactivate a customer. */
  [Permission.CLIENTS_DEACTIVATE]: [ADMIN, SUPER_ADMIN],
  /** Write an internal note on a technician or a customer. */
  [Permission.NOTES_WRITE]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  // ---- Technicians
  /** Create, edit, approve, reject, suspend and reactivate a technician. */
  [Permission.ARTISANS_MANAGE]: [ADMIN, SUPER_ADMIN],
  /** Read the applications and verify the documents of a technician. */
  [Permission.ARTISANS_REVIEW]: [ADMIN, SUPER_ADMIN, SUPPORT],
  /** Read a technician’s position, missions, ratings and revenue. */
  [Permission.ARTISANS_ACTIVITY]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Read where a technician went on a job (the positions kept for a few days, for a dispute). Not the accountant. */
  [Permission.LOCATION_HISTORY]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  // ---- Jobs
  /** See every job (the staff who work on tickets). */
  [Permission.TICKETS_READ]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Write an internal note on a job. */
  [Permission.TICKETS_NOTE]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Give a job to a technician, change its status, cancel it, send it a quote. */
  [Permission.TICKETS_DISPATCH]: [ADMIN, SUPER_ADMIN, DISPATCHER],
  /** Move a job through its workflow and add events to its timeline. */
  [Permission.TICKETS_WORKFLOW]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Read the statuses a job may move to. */
  [Permission.WORKFLOW_NEXT_STATUSES]: [CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Read the timeline of a job one may see. */
  [Permission.WORKFLOW_TIMELINE]: [CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Add a proof (photo, signature) to a job. */
  [Permission.PROOFS_ADD]: [ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** List and review the proofs. */
  [Permission.PROOFS_REVIEW]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Work a mission: accept, travel, start, finish, report a problem. */
  [Permission.MISSIONS_WORK]: [ARTISAN],
  /** Go online or offline and send one’s position. */
  [Permission.ARTISAN_PRESENCE]: [ARTISAN],
  /** Keep one’s technician profile, zones, availability and bank details. */
  [Permission.ARTISAN_PROFILE]: [ARTISAN, ADMIN, SUPER_ADMIN],
  /** Keep one’s addresses. */
  [Permission.CLIENT_ADDRESSES]: [CLIENT, ADMIN, SUPER_ADMIN],
  /** Ask for a job, follow it and cancel it. */
  [Permission.CLIENT_REQUESTS]: [CLIENT, ADMIN, SUPER_ADMIN],
  // ---- Complaints
  /** Read the complaints. */
  [Permission.COMPLAINTS_READ]: [ADMIN, SUPER_ADMIN, SUPPORT, ACCOUNTANT],
  /** Assign, answer, contact the parties and close a complaint. */
  [Permission.COMPLAINTS_HANDLE]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Decide the refund a complaint asks for. */
  [Permission.COMPLAINTS_REFUND]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Be given a complaint to handle. */
  [Permission.COMPLAINTS_ASSIGNEE]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  // ---- Money
  /** Read the finance screens and exports. (Who is told when money needs a decision is `notices.money`.) */
  [Permission.FINANCE_READ]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Read the company’s identity and fiscal settings. */
  [Permission.COMPANY_READ]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Read the cash held by technicians. */
  [Permission.CASH_READ]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Record a remittance or an adjustment of a technician’s cash. */
  [Permission.CASH_WRITE]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** A technician collects cash and reads their own position. */
  [Permission.CASH_COLLECT]: [ARTISAN],
  /** Read, record, confirm, fail and cancel payments. */
  [Permission.PAYMENTS_HANDLE]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Refund a payment. */
  [Permission.PAYMENTS_REFUND]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Set the receipt of a payment or link it to an invoice. */
  [Permission.PAYMENTS_EDIT]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Ask the provider about a card payment. */
  [Permission.PAYMENTS_CHECK]: [CLIENT, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Read the receipt of a payment one may see. */
  [Permission.PAYMENTS_RECEIPT]: [CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** A customer pays for their job. */
  [Permission.PAYMENTS_PAY]: [CLIENT],
  /** Make an invoice and send it by e-mail. */
  [Permission.INVOICES_ISSUE]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Cancel an invoice or issue a credit note. */
  [Permission.INVOICES_VOID]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Export the invoices. */
  [Permission.INVOICES_EXPORT]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Read an invoice one may see. */
  [Permission.INVOICES_VIEW]: [CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** A customer reads their own invoices. */
  [Permission.INVOICES_MINE]: [CLIENT],
  // ---- Quotes
  /** Write, edit, send and cancel a quote. */
  [Permission.QUOTES_WRITE]: [ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Expire a quote and list the ones that lapsed. */
  [Permission.QUOTES_EXPIRE]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Read a quote and its revisions. */
  [Permission.QUOTES_READ]: [ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** List the quotes of a job. */
  [Permission.QUOTES_FOR_JOB]: [CLIENT, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** A customer accepts, rejects or questions a quote. */
  [Permission.QUOTES_RESPOND]: [CLIENT],
  // ---- Files
  /** Read, replace and delete the files one may see. */
  [Permission.FILES_USE]: [CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Change who sees a file. */
  [Permission.FILES_VISIBILITY]: [ADMIN, SUPER_ADMIN],
  /** Add a photo of the damage to a job. */
  [Permission.FILES_DAMAGE_PHOTO]: [CLIENT, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Upload a technician’s documents. */
  [Permission.FILES_ARTISAN_DOCS]: [ARTISAN, ADMIN, SUPER_ADMIN],
  /** Attach a PDF to a quote. */
  [Permission.FILES_QUOTE_PDF]: [ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Attach a PDF to an invoice. */
  [Permission.FILES_INVOICE_PDF]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Attach a file to a complaint. */
  [Permission.FILES_COMPLAINT_ATTACHMENT]: [CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  // ---- Settings
  /** Read and manage one’s own notifications and devices. */
  [Permission.NOTIFICATIONS_OWN]: [CLIENT, ARTISAN, ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Send, list and read the notifications of others; test a delivery. */
  [Permission.NOTIFICATIONS_MANAGE]: [ADMIN, SUPER_ADMIN],
  /** Edit a notification somebody else wrote. */
  [Permission.NOTIFICATIONS_EDIT_ANY]: [SUPER_ADMIN],
  /** Read the zones and the notification templates. */
  [Permission.SETTINGS_READ]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER, ACCOUNTANT],
  /** Change the company settings, the zones, the prices and the templates. */
  [Permission.SETTINGS_MANAGE]: [ADMIN, SUPER_ADMIN],
  /** Read the service catalogue as the back office sees it. */
  [Permission.CATALOG_READ_ADMIN]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
  /** Create, edit, activate and delete services. */
  [Permission.CATALOG_MANAGE]: [ADMIN, SUPER_ADMIN],
  // ---- Notices
  /** Is told when money needs a person: a refund due, a payment received. */
  [Permission.NOTICES_MONEY]: [ADMIN, SUPER_ADMIN, ACCOUNTANT],
  /** Is told of disputes and of messages that wait for support. */
  [Permission.NOTICES_SUPPORT]: [ADMIN, SUPER_ADMIN, SUPPORT],
  /** Is told of jobs that need a technician or a decision. */
  [Permission.NOTICES_DISPATCH]: [ADMIN, SUPER_ADMIN, SUPPORT, DISPATCHER],
};

for (const holders of Object.values(TABLE)) Object.freeze(holders);

export const PERMISSION_ROLES: Readonly<Record<Permission, readonly Role[]>> = Object.freeze(TABLE);

/** Does this role hold this permission? A role the table does not know (or no role) holds nothing. */
export function can(role: Role | string | null | undefined, permission: Permission): boolean {
  const holders = isPermission(permission) ? PERMISSION_ROLES[permission] : undefined;

  return holders !== undefined && holders.includes(role as Role);
}

/** The roles that hold a permission, in the order of the `Role` enum. A copy: the table cannot be changed through it. */
export function rolesWith(permission: Permission): Role[] {
  return isPermission(permission) ? [...PERMISSION_ROLES[permission]] : [];
}

/** The permissions a role holds, in the order of the table. */
export function permissionsOf(role: Role | string | null | undefined): Permission[] {
  return (Object.keys(PERMISSION_ROLES) as Permission[]).filter((permission) => can(role, permission));
}

/** Is this text the name of a permission? */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_ROLES, value);
}
