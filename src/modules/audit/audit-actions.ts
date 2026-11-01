/**
 * The audit log's list of actions (P3-02): for every write route a person of the back office can reach, what the
 * log calls it and what it acts on. A route that is neither in `AUDITED_ROUTES` nor in `NOT_AUDITED_ROUTES` (with its
 * reason) fails `audit-actions.spec.ts`, and so does an entry for a route that is gone: a new endpoint cannot be added
 * without deciding whether it is logged.
 *
 * The key is the route as `routeKey` writes it: the method, a space, the path without the `/api` prefix and with the
 * name of every `:parameter` dropped (`PATCH /users/:/reactivate`).
 *
 * An entry says:
 *  - `action`: the name in the log, `area.verb`;
 *  - `targetType`: what the action acts on (a word, no id);
 *  - where the id of the target is, one of `param` (the route parameter of that name), `fromResult` (the path, in the
 *    answer of the route, of the id of the thing it created: `id`, or `profile.id` when the answer wraps it), `self` (the
 *    account of the person who did it); none of them when the action has no id;
 *  - `details`: the fields, among the ones sent in the body or in the path, whose VALUE is kept. Everything else is
 *    kept by NAME only. A field whose name looks like a secret is refused by `audit-actions.spec.ts`.
 *
 * Only the writes of the back office are logged (the interceptor looks at who is asking): a customer who calls the
 * same route leaves nothing here.
 */

export interface AuditedRoute {
  action: string;
  targetType: string;
  param?: string;
  fromResult?: string;
  self?: true;
  details?: readonly string[];
}

/** Written in the order of the permission matrix: the jobs, the technicians, the clients, the complaints, the money, the rest. */
export const AUDITED_ROUTES: Readonly<Record<string, AuditedRoute>> = Object.freeze({
  'POST /admin/interventions/:/assign-artisan': { action: 'interventions.assign-artisan', targetType: 'Intervention', param: 'id', details: ['artisanId'] },
  'PATCH /admin/interventions/:/status': { action: 'interventions.set-status', targetType: 'Intervention', param: 'id', details: ['status'] },
  'PATCH /admin/interventions/:/cancel': { action: 'interventions.cancel', targetType: 'Intervention', param: 'id', details: ['reason'] },
  'POST /admin/interventions/:/quotes': { action: 'interventions.create-quote', targetType: 'Intervention', param: 'id' },
  'POST /admin/interventions/:/internal-notes': { action: 'interventions.add-note', targetType: 'Intervention', param: 'id' },
  'POST /matching/admin/interventions/:/assign-best': { action: 'interventions.assign-best-artisan', targetType: 'Intervention', param: 'interventionId' },
  'POST /matching/admin/interventions/:/assign/:': { action: 'interventions.assign-artisan', targetType: 'Intervention', param: 'interventionId', details: ['artisanId'] },
  'PATCH /interventions/:/workflow/status': { action: 'interventions.set-workflow-status', targetType: 'Intervention', param: 'id', details: ['status'] },
  'POST /interventions/:/workflow/events': { action: 'interventions.add-timeline-event', targetType: 'Intervention', param: 'id', details: ['type'] },
  'POST /interventions/secure': { action: 'interventions.create', targetType: 'Intervention', fromResult: 'id' },
  'POST /interventions/:/proofs/:': { action: 'proofs.add', targetType: 'Intervention', param: 'id', details: ['kind'] },
  'PATCH /proofs/:/review': { action: 'proofs.review', targetType: 'ProofCapture', param: 'id', details: ['decision'] },
  'POST /admin/artisans': { action: 'artisans.create', targetType: 'ArtisanProfile', fromResult: 'profile.id' },
  'PATCH /admin/artisans/:': { action: 'artisans.update', targetType: 'ArtisanProfile', param: 'profileId' },
  'PATCH /admin/artisans/:/approve': { action: 'artisans.approve', targetType: 'ArtisanProfile', param: 'profileId' },
  'PATCH /admin/artisans/:/reject': { action: 'artisans.reject', targetType: 'ArtisanProfile', param: 'profileId' },
  'PATCH /admin/artisans/:/suspend': { action: 'artisans.suspend', targetType: 'ArtisanProfile', param: 'profileId' },
  'PATCH /admin/artisans/:/reactivate': { action: 'artisans.reactivate', targetType: 'ArtisanProfile', param: 'profileId' },
  'PATCH /admin/artisans/documents/:/verify': { action: 'artisans.verify-document', targetType: 'ArtisanDocument', param: 'documentId', details: ['status'] },
  'POST /admin/artisans/:/internal-notes': { action: 'artisans.add-note', targetType: 'ArtisanProfile', param: 'profileId' },
  'PATCH /artisans/me/profile': { action: 'artisan-profile.update', targetType: 'User', self: true },
  'POST /artisans/me/documents': { action: 'artisan-profile.add-document', targetType: 'User', self: true },
  'POST /artisans/me/service-zones': { action: 'artisan-profile.add-zone', targetType: 'User', self: true },
  'DELETE /artisans/me/service-zones/:': { action: 'artisan-profile.remove-zone', targetType: 'User', self: true },
  'PATCH /artisans/me/availability': { action: 'artisan-profile.set-availability', targetType: 'User', self: true },
  'PATCH /artisans/me/bank-details': { action: 'artisan-profile.update-bank-details', targetType: 'User', self: true },
  'PATCH /admin/clients/:': { action: 'clients.update', targetType: 'User', param: 'clientId' },
  'PATCH /admin/clients/:/deactivate': { action: 'clients.deactivate', targetType: 'User', param: 'clientId' },
  'POST /admin/clients/:/internal-notes': { action: 'clients.add-note', targetType: 'User', param: 'clientId' },
  'POST /client/addresses': { action: 'client-addresses.create', targetType: 'ClientAddress', fromResult: 'id' },
  'PATCH /client/addresses/:': { action: 'client-addresses.update', targetType: 'ClientAddress', param: 'id' },
  'DELETE /client/addresses/:': { action: 'client-addresses.delete', targetType: 'ClientAddress', param: 'id' },
  'POST /client/interventions': { action: 'client-interventions.create', targetType: 'Intervention', fromResult: 'id' },
  'PATCH /client/interventions/:/cancel': { action: 'client-interventions.cancel', targetType: 'Intervention', param: 'id' },
  'PATCH /admin/complaints/:/assign': { action: 'complaints.assign', targetType: 'Complaint', param: 'complaintId', details: ['supportAgentId'] },
  'PATCH /admin/complaints/:/status': { action: 'complaints.set-status', targetType: 'Complaint', param: 'complaintId', details: ['status'] },
  'POST /admin/complaints/:/internal-notes': { action: 'complaints.add-note', targetType: 'Complaint', param: 'complaintId' },
  'POST /admin/complaints/:/contact-client': { action: 'complaints.contact-client', targetType: 'Complaint', param: 'complaintId' },
  'POST /admin/complaints/:/contact-artisan': { action: 'complaints.contact-artisan', targetType: 'Complaint', param: 'complaintId' },
  'PATCH /admin/complaints/:/refund': { action: 'complaints.decide-refund', targetType: 'Complaint', param: 'complaintId', details: ['approved', 'amount'] },
  'PATCH /admin/complaints/:/close': { action: 'complaints.close', targetType: 'Complaint', param: 'complaintId' },
  'POST /complaints/interventions/:': { action: 'complaints.open', targetType: 'Intervention', param: 'interventionId' },
  'PATCH /complaints/admin/:/assign': { action: 'complaints.assign', targetType: 'Complaint', param: 'complaintId', details: ['assignedToId'] },
  'PATCH /complaints/admin/:/status': { action: 'complaints.set-status', targetType: 'Complaint', param: 'complaintId', details: ['status'] },
  'PATCH /complaints/admin/:/resolve': { action: 'complaints.resolve', targetType: 'Complaint', param: 'complaintId' },
  'POST /complaints/:/artisan-response': { action: 'complaints.artisan-response', targetType: 'Complaint', param: 'complaintId' },
  'POST /business/interventions/:/financials': { action: 'business.record-financials', targetType: 'Intervention', param: 'interventionId', details: ['commissionRate'] },
  'POST /business/reports/monthly': { action: 'business.generate-monthly-report', targetType: 'MonthlyReport', details: ['year', 'month'] },
  'POST /business/payouts': { action: 'business.create-payout', targetType: 'Payout', fromResult: 'id', details: ['artisanId'] },
  'PATCH /business/payouts/:/paid': { action: 'business.mark-payout-paid', targetType: 'Payout', param: 'payoutId' },
  'PATCH /business/payouts/:/cancel': { action: 'business.cancel-payout', targetType: 'Payout', param: 'payoutId' },
  'POST /cash-ledger/artisans/:/remittances': { action: 'cash.record-remittance', targetType: 'User', param: 'artisanId', details: ['amount'] },
  'POST /cash-ledger/artisans/:/adjustments': { action: 'cash.adjust', targetType: 'User', param: 'artisanId', details: ['commissionAmount', 'cashAmount'] },
  'POST /payments/admin/interventions/:': { action: 'payments.record', targetType: 'Intervention', param: 'interventionId', details: ['method', 'amount'] },
  'PATCH /payments/:/confirm': { action: 'payments.confirm', targetType: 'Payment', param: 'paymentId' },
  'PATCH /payments/:/fail': { action: 'payments.fail', targetType: 'Payment', param: 'paymentId', details: ['reason'] },
  'PATCH /payments/:/cancel': { action: 'payments.cancel', targetType: 'Payment', param: 'paymentId', details: ['reason'] },
  'PATCH /payments/:/refund': { action: 'payments.refund', targetType: 'Payment', param: 'paymentId', details: ['amount', 'reason'] },
  'POST /payments/:/check': { action: 'payments.check', targetType: 'Payment', param: 'paymentId' },
  'PATCH /payments/:/receipt-url': { action: 'payments.set-receipt-url', targetType: 'Payment', param: 'paymentId' },
  'PATCH /payments/:/invoice/:': { action: 'payments.link-invoice', targetType: 'Payment', param: 'paymentId' },
  'POST /invoices/interventions/:': { action: 'invoices.issue', targetType: 'Intervention', param: 'interventionId' },
  'POST /invoices/generate': { action: 'invoices.generate', targetType: 'Invoice', fromResult: 'id' },
  'POST /invoices/:/credit-notes': { action: 'invoices.create-credit-note', targetType: 'Invoice', param: 'invoiceId' },
  'POST /invoices/:/send-email': { action: 'invoices.send-email', targetType: 'Invoice', param: 'invoiceId' },
  'PATCH /invoices/:/cancel': { action: 'invoices.cancel', targetType: 'Invoice', param: 'invoiceId', details: ['reason'] },
  'POST /quotes/interventions/:': { action: 'quotes.create', targetType: 'Intervention', param: 'interventionId' },
  'POST /quotes/interventions/:/draft': { action: 'quotes.save-draft', targetType: 'Intervention', param: 'interventionId' },
  'PATCH /quotes/:': { action: 'quotes.update', targetType: 'Quote', param: 'quoteId' },
  'POST /quotes/:/send': { action: 'quotes.send', targetType: 'Quote', param: 'quoteId' },
  'POST /quotes/:/cancel': { action: 'quotes.cancel', targetType: 'Quote', param: 'quoteId' },
  'POST /quotes/:/expire': { action: 'quotes.expire', targetType: 'Quote', param: 'quoteId' },
  'PATCH /quotes/:/pdf': { action: 'quotes.set-pdf', targetType: 'Quote', param: 'quoteId' },
  'POST /files/interventions/:/damage-photo': { action: 'files.upload-damage-photo', targetType: 'Intervention', param: 'interventionId' },
  'POST /files/artisan/documents': { action: 'files.upload-artisan-document', targetType: 'File', fromResult: 'asset.id' },
  'POST /files/artisan/identity': { action: 'files.upload-identity', targetType: 'File', fromResult: 'asset.id' },
  'POST /files/artisan/insurance': { action: 'files.upload-insurance', targetType: 'File', fromResult: 'asset.id' },
  'POST /files/quotes/:/pdf': { action: 'files.upload-quote-pdf', targetType: 'Quote', param: 'quoteId' },
  'POST /files/invoices/:/pdf': { action: 'files.upload-invoice-pdf', targetType: 'Invoice', param: 'invoiceId' },
  'POST /files/complaints/:/attachment': { action: 'files.upload-complaint-attachment', targetType: 'Complaint', param: 'complaintId' },
  'PATCH /files/:/replace': { action: 'files.replace', targetType: 'File', param: 'fileId' },
  'PATCH /files/:/visibility': { action: 'files.set-visibility', targetType: 'File', param: 'fileId', details: ['visibility'] },
  'DELETE /files/:': { action: 'files.delete', targetType: 'File', param: 'fileId' },
  'POST /reviews/interventions/:': { action: 'reviews.create', targetType: 'Intervention', param: 'interventionId' },
  'PATCH /reviews/admin/:/moderate': { action: 'reviews.moderate', targetType: 'Review', param: 'reviewId', details: ['status'] },
  'DELETE /messages/:': { action: 'messages.delete', targetType: 'Message', param: 'messageId' },
  'POST /notifications': { action: 'notifications.send', targetType: 'Notification', fromResult: 'id' },
  'POST /notifications/test-delivery': { action: 'notifications.test-delivery', targetType: 'Notification' },
  'PATCH /notifications/:': { action: 'notifications.edit', targetType: 'Notification', param: 'notificationId', details: ['isRead'] },
  'POST /scheduling/interventions/:/preferred-time': { action: 'scheduling.set-preferred-time', targetType: 'Intervention', param: 'interventionId' },
  'POST /scheduling/appointments/:/reschedule-request': { action: 'scheduling.request-reschedule', targetType: 'Appointment', param: 'appointmentId' },
  'POST /scheduling/appointments/:/cancel-request': { action: 'scheduling.request-cancel', targetType: 'Appointment', param: 'appointmentId' },
  'POST /scheduling/admin/interventions/:/schedule': { action: 'scheduling.schedule', targetType: 'Intervention', param: 'interventionId', details: ['artisanId'] },
  'PATCH /scheduling/admin/requests/:/review': { action: 'scheduling.review-request', targetType: 'AppointmentRequest', param: 'requestId' },
  'PATCH /scheduling/artisan/appointments/:/accept': { action: 'scheduling.accept-appointment', targetType: 'Appointment', param: 'appointmentId' },
  'POST /scheduling/artisan/availability': { action: 'scheduling.set-availability', targetType: 'User', self: true },
  'POST /scheduling/artisan/time-blocks': { action: 'scheduling.add-time-block', targetType: 'User', self: true, details: ['type'] },
  'PATCH /admin/settings/company': { action: 'settings.update-company', targetType: 'CompanySettings' },
  'POST /admin/settings/service-zones': { action: 'settings.create-zone', targetType: 'ServiceZone', fromResult: 'id' },
  'PATCH /admin/settings/service-zones/:': { action: 'settings.update-zone', targetType: 'ServiceZone', param: 'zoneId' },
  'DELETE /admin/settings/service-zones/:': { action: 'settings.delete-zone', targetType: 'ServiceZone', param: 'zoneId' },
  'PATCH /admin/settings/service-categories/:': { action: 'settings.update-category', targetType: 'ServiceCategory', param: 'categoryId' },
  'PATCH /admin/settings/sub-services/:': { action: 'settings.update-sub-service', targetType: 'SubService', param: 'subServiceId' },
  'POST /admin/settings/notification-templates': { action: 'settings.create-template', targetType: 'NotificationTemplate', fromResult: 'id' },
  'PATCH /admin/settings/notification-templates/:': { action: 'settings.update-template', targetType: 'NotificationTemplate', param: 'templateId' },
  'DELETE /admin/settings/notification-templates/:': { action: 'settings.delete-template', targetType: 'NotificationTemplate', param: 'templateId' },
  'POST /services/admin/categories': { action: 'catalog.create-category', targetType: 'ServiceCategory', fromResult: 'id' },
  'POST /services/admin/sub-services': { action: 'catalog.create-sub-service', targetType: 'SubService', fromResult: 'id' },
  'PATCH /services/admin/sub-services/:': { action: 'catalog.update-sub-service', targetType: 'SubService', param: 'id' },
  'DELETE /services/admin/sub-services/:': { action: 'catalog.delete-sub-service', targetType: 'SubService', param: 'id' },
  'PATCH /services/admin/categories/:': { action: 'catalog.update-category', targetType: 'ServiceCategory', param: 'id' },
  'PATCH /services/admin/categories/:/activate': { action: 'catalog.activate-category', targetType: 'ServiceCategory', param: 'id' },
  'PATCH /services/admin/categories/:/deactivate': { action: 'catalog.deactivate-category', targetType: 'ServiceCategory', param: 'id' },
  'PATCH /services/admin/sub-services/:/activate': { action: 'catalog.activate-sub-service', targetType: 'SubService', param: 'id' },
  'PATCH /services/admin/sub-services/:/deactivate': { action: 'catalog.deactivate-sub-service', targetType: 'SubService', param: 'id' },
  'POST /users': { action: 'users.create', targetType: 'User', fromResult: 'id', details: ['role'] },
  'POST /users/staff/create': { action: 'users.create-staff', targetType: 'User', fromResult: 'id', details: ['role'] },
  'PATCH /users/:': { action: 'users.update', targetType: 'User', param: 'id', details: ['role', 'isActive'] },
  'DELETE /users/:': { action: 'users.delete', targetType: 'User', param: 'id' },
  'POST /users/:/password-setup-link': { action: 'users.send-password-setup', targetType: 'User', param: 'id' },
  'PATCH /users/:/reactivate': { action: 'users.reactivate', targetType: 'User', param: 'id' },
  'PATCH /users/me': { action: 'account.update', targetType: 'User', self: true },
  'PATCH /users/me/locale': { action: 'account.set-locale', targetType: 'User', self: true, details: ['locale'] },
  'PATCH /users/profile': { action: 'account.update-profile', targetType: 'User', self: true },
  'DELETE /users/me': { action: 'account.delete', targetType: 'User', self: true },
  'POST /users/me/email-change': { action: 'account.request-email-change', targetType: 'User', self: true },
  'POST /users/me/phone-change': { action: 'account.request-phone-change', targetType: 'User', self: true },
  'POST /users/me/phone-change/confirm': { action: 'account.confirm-phone-change', targetType: 'User', self: true },
  'POST /auth/logout-everywhere': { action: 'auth.logout-everywhere', targetType: 'User', self: true },
  'POST /auth/change-password': { action: 'auth.change-password', targetType: 'User', self: true },
  'POST /auth/phone/verify': { action: 'auth.verify-phone', targetType: 'User', self: true },
});

/** The write routes that are left out of the log on purpose, each with its reason (a route here is not logged, whoever calls it). */
export const NOT_AUDITED_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  'PATCH /notifications/preferences/me': 'The person\'s own notices and devices: housekeeping on their own screen, nothing the business decides.',
  'POST /notifications/push-tokens': 'The person\'s own notices and devices: housekeeping on their own screen, nothing the business decides.',
  'DELETE /notifications/push-tokens/:': 'The person\'s own notices and devices: housekeeping on their own screen, nothing the business decides.',
  'PATCH /notifications/read-all': 'The person\'s own notices and devices: housekeeping on their own screen, nothing the business decides.',
  'PATCH /notifications/:/read': 'The person\'s own notices and devices: housekeeping on their own screen, nothing the business decides.',
  'DELETE /notifications/:': 'The person\'s own notices and devices: housekeeping on their own screen, nothing the business decides.',
  'POST /auth/email/send-verification': 'Sends a code to the address the account already has; nothing changes until it is entered.',
  'POST /auth/phone/send-code': 'Sends a code; nothing changes until it is entered (the confirmation is logged).',
  'PATCH /messages/interventions/:/read': 'A read mark on the person\'s own side of a conversation.',
  'PATCH /messages/:/read': 'A read mark on the person\'s own side of a conversation.',
  'POST /messages/interventions/:': 'A chat message: the message row keeps who wrote it and when, and a back-office note has its own entry.',
  'POST /complaints/:/messages': 'A chat message: the message row keeps who wrote it and when.',
  'PATCH /users/location': 'A position ping every few seconds, not a decision: logging it would bury the log.',
});
