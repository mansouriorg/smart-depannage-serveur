/**
 * Who opens which page of the back-office dashboard, and who sees which button (P1-12).
 *
 * Before, the dashboard let two roles in (ADMIN and SUPER_ADMIN) and showed all of them every page.
 * The server has five staff roles, and each page of the dashboard calls routes that only some of
 * them may call: a dispatcher who opened "Candidatures" got a page full of refusals. This table
 * says, once, which role belongs on which page. The dashboard reads it for its menu, its route
 * guard and the buttons it shows; `staff-pages.spec.ts` reads the controllers and fails when a page
 * or a button is offered to a role whose calls the API refuses (or the other way round, for the
 * buttons), so the table cannot drift from the routes.
 *
 * It is a convenience for the people at the keyboard. The API is what keeps a role out: a hand-made
 * request to a route that is not the role's gets a 403 whatever this table says.
 *
 * Nothing here imports anything or reads `process`: the file is copied as it is into the shared
 * package, where the dashboard uses it.
 */

export const STAFF_ROLES = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER', 'ACCOUNTANT'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/** The role as a person reads it. */
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  ADMIN: 'Administrateur',
  SUPER_ADMIN: 'Super administrateur',
  SUPPORT: 'Support',
  DISPATCHER: 'Dispatcheur',
  ACCOUNTANT: 'Comptable',
};

/** The role of a staff account, or null for a customer, an artisan, or anything else. */
export function staffRoleOf(value: unknown): StaffRole | null {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value) ? (value as StaffRole) : null;
}

/** The role as a person reads it; the text itself for a role this table does not know. */
export function staffRoleLabel(role: string | null | undefined): string {
  const known = staffRoleOf(role);

  return known ? STAFF_ROLE_LABELS[known] : (role ?? '');
}

/** A route of the API, written the way the controllers write it (`:id` for a parameter), without the `/api` prefix. */
export interface ApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  /**
   * The route belongs to this page alone: the roles it accepts are exactly the roles of the page
   * (a role that cannot open the page has no business reading what it shows).
   */
  only?: true;
}

export type PageId = 'overview' | 'interventions' | 'applications' | 'technicians' | 'feedbacks' | 'finance' | 'complaints' | 'company' | 'settings';

export interface DashboardPage {
  id: PageId;
  /** The address of the page; the pages under it (`/dashboard/tickets/12`) have the same roles. */
  path: string;
  label: string;
  roles: readonly StaffRole[];
  /** What the page reads from the API to show itself. */
  calls: readonly ApiCall[];
}

const TICKET_STAFF: readonly StaffRole[] = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'DISPATCHER'];
const VERIFIERS: readonly StaffRole[] = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'];
const MANAGERS: readonly StaffRole[] = ['ADMIN', 'SUPER_ADMIN'];
/** Who handles money in the back office (P2-08): the administrators and the accountant. */
const FINANCE_STAFF: readonly StaffRole[] = ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT'];
/** Who reads the complaints (P2-09): the team that runs them, and the accountant, who decides the refunds they ask for. */
const COMPLAINT_STAFF: readonly StaffRole[] = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT', 'ACCOUNTANT'];
/** Who reads the company's identity and fiscal rules (P2-09): the administrators, and the accountant, who prints the invoices with them. */
const COMPANY_READERS: readonly StaffRole[] = ['ADMIN', 'SUPER_ADMIN', 'ACCOUNTANT'];
/** Who gives jobs to technicians and moves their status (the matching and the admin routes for it). */
const DISPATCHERS: readonly StaffRole[] = ['ADMIN', 'SUPER_ADMIN', 'DISPATCHER'];

/** The pages in the order of the menu. */
export const DASHBOARD_PAGES: readonly DashboardPage[] = [
  {
    id: 'overview',
    path: '/dashboard',
    label: "Vue d'ensemble",
    roles: TICKET_STAFF,
    calls: [{ method: 'GET', path: '/interventions/dashboard/stats' }],
  },
  {
    id: 'interventions',
    path: '/dashboard/tickets',
    label: 'Interventions',
    roles: TICKET_STAFF,
    calls: [
      // The dispatcher's list (P1-13): a page at a time, filtered, searched, in the order of work.
      { method: 'GET', path: '/admin/interventions' },
      // The case file of a job (P1-14): the whole history, for the roles that work on jobs.
      { method: 'GET', path: '/admin/interventions/:id' },
      { method: 'GET', path: '/proofs' },
    ],
  },
  {
    id: 'applications',
    path: '/dashboard/applications',
    label: 'Candidatures',
    roles: VERIFIERS,
    calls: [
      { method: 'GET', path: '/admin/artisans', only: true },
      { method: 'GET', path: '/admin/artisans/:profileId', only: true },
    ],
  },
  {
    id: 'technicians',
    path: '/dashboard/technicians',
    label: 'Techniciens',
    roles: TICKET_STAFF,
    calls: [{ method: 'GET', path: '/users/artisans' }],
  },
  {
    // The moderation queue of the reviews customers wrote (P2-09): support follows the quality of the work; dispatching does not
    // need it. (Until P2-09 the page listed the star ratings of jobs, from GET /interventions; no review could be decided.)
    id: 'feedbacks',
    path: '/dashboard/feedbacks',
    label: 'Avis & Retours',
    roles: VERIFIERS,
    calls: [{ method: 'GET', path: '/reviews/admin' }],
  },
  {
    // The finance console (P2-08): payments that wait for the team, refunds, invoices and credit notes, payouts, the cash that
    // artisans hold. The reads are the finance routes; the writes are the routes of the payments, invoices, payouts and cash
    // ledger, which the buttons of the page call: every role of the page is served by every one of them (checked in the spec).
    id: 'finance',
    path: '/dashboard/finance',
    label: 'Finance',
    roles: FINANCE_STAFF,
    calls: [
      { method: 'GET', path: '/finance/summary', only: true },
      { method: 'GET', path: '/finance/payments', only: true },
      { method: 'GET', path: '/finance/payments/export', only: true },
      { method: 'GET', path: '/finance/invoices', only: true },
      { method: 'GET', path: '/finance/refunds-due', only: true },
      { method: 'GET', path: '/cash-ledger/balances', only: true },
      { method: 'GET', path: '/cash-ledger/artisans/:artisanId', only: true },
      { method: 'GET', path: '/business/payouts' },
      { method: 'GET', path: '/business/payouts/preview' },
      { method: 'GET', path: '/invoices/:invoiceId/pdf' },
      { method: 'GET', path: '/invoices/credit-notes/:creditNoteId/pdf' },
      { method: 'GET', path: '/payments/:paymentId/receipt' },
      { method: 'PATCH', path: '/payments/:paymentId/confirm' },
      { method: 'PATCH', path: '/payments/:paymentId/fail' },
      { method: 'PATCH', path: '/payments/:paymentId/cancel' },
      { method: 'PATCH', path: '/payments/:paymentId/refund' },
      { method: 'POST', path: '/invoices/:invoiceId/credit-notes' },
      { method: 'POST', path: '/cash-ledger/artisans/:artisanId/remittances' },
      { method: 'POST', path: '/business/payouts' },
      { method: 'PATCH', path: '/business/payouts/:payoutId/paid' },
      { method: 'PATCH', path: '/business/payouts/:payoutId/cancel' },
    ],
  },
  {
    // The complaints of customers (P2-09): the list with its views, and the case of one complaint. The writes are the buttons
    // (`handleComplaint`, `decideComplaintRefund`), because not every role of the page may do each of them.
    id: 'complaints',
    path: '/dashboard/complaints',
    label: 'Réclamations',
    roles: COMPLAINT_STAFF,
    calls: [
      { method: 'GET', path: '/admin/complaints' },
      { method: 'GET', path: '/admin/complaints/:complaintId' },
      // The agents a case can be given to.
      { method: 'GET', path: '/users' },
    ],
  },
  {
    // The identity of the company and its fiscal rules, as the invoices print them (P2-09). The administrators change them
    // (`editCompany`); the accountant reads them.
    id: 'company',
    path: '/dashboard/company',
    label: 'Entreprise',
    roles: COMPANY_READERS,
    calls: [{ method: 'GET', path: '/admin/settings/company' }],
  },
  {
    // The signed-in person's own profile: every staff role has one.
    id: 'settings',
    path: '/dashboard/settings',
    label: 'Paramètres',
    roles: STAFF_ROLES,
    calls: [
      { method: 'GET', path: '/users/profile' },
      { method: 'PATCH', path: '/users/profile' },
    ],
  },
];

/**
 * What every page of the dashboard reads to build its frame (the menu and the header need to know who is
 * signed in): any staff role, whatever its pages.
 */
export const DASHBOARD_SHELL_CALLS: readonly ApiCall[] = [{ method: 'GET', path: '/users/me' }];

export type ActionId =
  | 'assignTicket'
  | 'changeTicket'
  | 'addNote'
  | 'reviewProof'
  | 'verifyDocument'
  | 'decideApplication'
  | 'inviteTechnician'
  | 'manageTechnician'
  | 'handleComplaint'
  | 'decideComplaintRefund'
  | 'moderateReview'
  | 'editCompany';

export interface StaffAction {
  id: ActionId;
  label: string;
  /** The roles the button is shown to. They are all served by every call: a button is never shown to a role whose call is refused. */
  roles: readonly StaffRole[];
  /**
   * Roles whose calls succeed although the button is not shown to them, because the service lets every staff role in and the
   * dashboard keeps the work with the roles that do it (P2-09). The spec checks `roles` and `alsoServed` together are exactly
   * the roles of the calls, so that a route that is tightened or widened is noticed here.
   */
  alsoServed?: readonly StaffRole[];
  calls: readonly ApiCall[];
}

export const STAFF_ACTIONS: readonly StaffAction[] = [
  {
    id: 'assignTicket',
    label: 'Assigner un technicien à une demande',
    roles: DISPATCHERS,
    calls: [
      { method: 'GET', path: '/matching/admin/interventions/:interventionId/artisans' },
      { method: 'POST', path: '/matching/admin/interventions/:interventionId/assign/:artisanId' },
    ],
  },
  {
    id: 'changeTicket',
    label: 'Changer le statut d’une demande ou l’annuler',
    roles: DISPATCHERS,
    calls: [
      { method: 'PATCH', path: '/admin/interventions/:id/status' },
      { method: 'PATCH', path: '/admin/interventions/:id/cancel' },
    ],
  },
  {
    id: 'addNote',
    label: 'Ajouter une note interne à une demande',
    roles: TICKET_STAFF,
    calls: [{ method: 'POST', path: '/admin/interventions/:id/internal-notes' }],
  },
  {
    id: 'reviewProof',
    label: 'Valider ou refuser une preuve de travail',
    roles: TICKET_STAFF,
    calls: [{ method: 'PATCH', path: '/proofs/:id/review' }],
  },
  {
    id: 'verifyDocument',
    label: "Vérifier un document d'un candidat",
    roles: VERIFIERS,
    calls: [{ method: 'PATCH', path: '/admin/artisans/documents/:documentId/verify' }],
  },
  {
    id: 'decideApplication',
    label: 'Accepter ou refuser une candidature',
    roles: MANAGERS,
    calls: [
      { method: 'PATCH', path: '/admin/artisans/:profileId/approve' },
      { method: 'PATCH', path: '/admin/artisans/:profileId/reject' },
    ],
  },
  {
    id: 'inviteTechnician',
    label: 'Inviter un technicien',
    roles: MANAGERS,
    calls: [{ method: 'POST', path: '/admin/artisans' }],
  },
  {
    id: 'manageTechnician',
    label: "Désactiver un technicien ou lui renvoyer un lien de mot de passe",
    roles: MANAGERS,
    calls: [
      { method: 'DELETE', path: '/users/:id' },
      { method: 'POST', path: '/users/:id/password-setup-link' },
    ],
  },
  {
    // Support runs a complaint: takes it, writes to the customer, moves its status, closes it. The routes let every staff role in
    // (the service only refuses a customer or an artisan), so the dispatcher and the accountant could call them by hand.
    id: 'handleComplaint',
    label: 'Prendre en charge une réclamation, répondre, changer son statut ou la clore',
    roles: VERIFIERS,
    alsoServed: ['DISPATCHER', 'ACCOUNTANT'],
    calls: [
      { method: 'PATCH', path: '/complaints/admin/:complaintId/assign' },
      { method: 'PATCH', path: '/complaints/admin/:complaintId/status' },
      { method: 'PATCH', path: '/complaints/admin/:complaintId/resolve' },
      { method: 'POST', path: '/complaints/:complaintId/messages' },
      { method: 'POST', path: '/admin/complaints/:complaintId/internal-notes' },
    ],
  },
  {
    // Money going back to a customer is decided by the administrators and the accountant: exactly the roles of the route.
    id: 'decideComplaintRefund',
    label: 'Accepter ou refuser le remboursement demandé dans une réclamation',
    roles: FINANCE_STAFF,
    calls: [{ method: 'PATCH', path: '/admin/complaints/:complaintId/refund' }],
  },
  {
    id: 'moderateReview',
    label: 'Approuver, refuser ou masquer un avis',
    roles: VERIFIERS,
    alsoServed: ['DISPATCHER', 'ACCOUNTANT'],
    calls: [{ method: 'PATCH', path: '/reviews/admin/:reviewId/moderate' }],
  },
  {
    id: 'editCompany',
    label: "Modifier l'identité, les règles de facturation et les moyens de paiement de l'entreprise",
    roles: MANAGERS,
    calls: [{ method: 'PATCH', path: '/admin/settings/company' }],
  },
];

/** True when this role may do this (the dashboard shows the button when it is). */
export function staffCan(role: string | null | undefined, action: ActionId): boolean {
  const staff = staffRoleOf(role);

  return staff !== null && STAFF_ACTIONS.some((candidate) => candidate.id === action && candidate.roles.includes(staff));
}

/** The pages of the menu of this role, in order. */
export function dashboardPagesFor(role: string | null | undefined): DashboardPage[] {
  const staff = staffRoleOf(role);

  return staff === null ? [] : DASHBOARD_PAGES.filter((page) => page.roles.includes(staff));
}

/**
 * An address as it is compared: without the query or the hash, decoded, in lower case, with one
 * slash between the parts and none at the end ("/Dashboard//tick%65ts/?a=1" -> "/dashboard/tickets").
 * Null for an address that cannot be decoded, or that walks up and down ("/dashboard/tickets/../applications"):
 * it is never a page.
 */
export function normalizeDashboardPath(pathname: string): string | null {
  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname.replace(/[?#].*$/, ''));
  } catch {
    return null;
  }

  const clean = decoded.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');

  if (clean.split('/').some((part) => part === '.' || part === '..')) return null;

  return clean === '' ? '/' : clean;
}

/** The page an address belongs to: `/dashboard/tickets/12` belongs to the interventions page. */
export function dashboardPageFor(pathname: string): DashboardPage | undefined {
  const clean = normalizeDashboardPath(pathname);

  if (clean === null) return undefined;

  return DASHBOARD_PAGES.find((page) => clean === page.path || (page.path !== '/dashboard' && clean.startsWith(`${page.path}/`)));
}

/** True when the address is somewhere in the dashboard (it belongs to the dashboard, even if no page has it). */
export function isDashboardPath(pathname: string): boolean {
  const clean = normalizeDashboardPath(pathname);

  // An address that cannot be read is treated as being in the dashboard: the guard then refuses it.
  return clean === null || clean === '/dashboard' || clean.startsWith('/dashboard/');
}

/**
 * True when this role may open this address. An address of the dashboard that no page claims is
 * refused for everybody (a page that is added to the dashboard but not to this table stays shut).
 */
export function canOpenDashboardPath(role: string | null | undefined, pathname: string): boolean {
  const staff = staffRoleOf(role);
  const page = dashboardPageFor(pathname);

  return staff !== null && page !== undefined && page.roles.includes(staff);
}

/** Where a role lands after signing in: the first page of its menu. `/` (the sign-in page) for a role that has none. */
export function dashboardHomeFor(role: string | null | undefined): string {
  return dashboardPagesFor(role)[0]?.path ?? '/';
}
