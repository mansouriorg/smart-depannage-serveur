import { INTERVENTION_COLUMNS, interventionColumnsFor, Viewer } from '../views/intervention-columns';

/**
 * Rows with a secret planted in every column that somebody may not read (P1-08), and a detector
 * that finds a secret in whatever a route answered. Test support only.
 *
 * A planted value looks like `SECRET<payment.adminNote>`: when it shows up in an answer, its name
 * says what leaked.
 */

export const secret = (name: string) => `SECRET<${name}>`;

/** The names of the secrets found in `value` (anything JSON can carry). */
export function leaked(value: unknown): string[] {
  const text = JSON.stringify(value ?? null) ?? '';
  const found = new Set<string>();

  for (const match of text.matchAll(/SECRET<([^>]+)>/g)) found.add(match[1]);

  return [...found].sort();
}

/** Secrets that no reader but the back office may ever find, whatever the route. */
export const STAFF_SECRETS = [
  'job.adminInternalNotes',
  'job.adminReviewStartedAt',
  'job.trackingToken',
  'job.cancelledById',
  'event.internalNote.message',
  'event.internalNote.title',
  'event.metadata',
  'event.createdById',
  'event.createdBy.name',
  'event.legacyArtisanProblem.message',
  'event.flaggedInternal.message',
  'quote.createdById',
  'quote.createdBy.email',
  'quote.draft.title',
  'payment.adminNote',
  'payment.providerPaymentId',
  'payment.createdById',
  'payment.confirmedById',
  'payment.refundedById',
  'payment.failureReason',
  'payment.refundReason',
  'invoice.emailedTo',
  'invoice.cancelReason',
  'invoice.draft.number',
  'review.moderationReason',
  'review.moderatedById',
  'complaint.adminNotes',
  'complaint.internalNotes',
  'complaint.adminDecisionNote',
  'complaint.adminDecisionById',
  'complaint.refundDecidedById',
  'complaint.assignedToId',
  'complaint.assignedTo.email',
  'message.internalAdmin.content',
  'message.deleted.content',
  'sender.email',
  'message.readByUserIds',
  'subService.none',
];

/** One job with everything a route may include, and a secret in every place that is not for everybody. */
export function poisonedJob(overrides: Record<string, unknown> = {}): Record<string, any> {
  const columns: Record<string, unknown> = {};

  for (const column of Object.keys(INTERVENTION_COLUMNS)) columns[column] = secret(`job.${column}`);

  return {
    ...columns,
    id: 1,
    status: 'ARTISAN_ASSIGNED',
    urgency: 'NORMAL',
    serviceType: 'PLUMBING',
    // The ids and figures a route reads to decide who the reader is keep real values (the columns
    // that are texts keep their secret, so a leak of the customer's number, the door code, the
    // address or the description to a reader who may not have it names itself).
    clientId: 10,
    artisanId: 20,
    subServiceId: 3,
    latitude: 36.8,
    longitude: 10.18,
    photos: ['/api/files/1/download'],
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T11:00:00Z'),
    client: {
      id: 10,
      name: 'Salah',
      phone: '+21620000000',
      email: 'salah@example.tn',
      isGuest: false,
      address: secret('client.address'),
    },
    artisan: {
      id: 20,
      name: 'Ali',
      phone: '+21621111111',
      email: secret('artisan.email'),
      latitude: 36.81,
      longitude: 10.19,
    },
    subService: { id: 3, categoryId: 1, name: 'Fuite', description: 'd', estimatedDuration: 60, basePrice: 50, emergencyPrice: 80, requiresPhotos: true, isActive: true },
    events: [
      { id: 1, interventionId: 1, type: 'REQUEST_CREATED', title: 'Demande créée', message: 'Votre demande a été enregistrée.', createdAt: new Date('2026-10-01T10:00:00Z'), createdById: secret('event.createdById'), metadata: secret('event.metadata') },
      { id: 2, interventionId: 1, type: 'INTERNAL_NOTE_ADDED', title: secret('event.internalNote.title'), message: secret('event.internalNote.message'), createdAt: new Date(), createdById: 5 },
      { id: 3, interventionId: 1, type: 'ISSUE_REPORTED', title: 'Problème signalé par artisan', message: secret('event.legacyArtisanProblem.message'), createdAt: new Date(), createdById: 20 },
      { id: 4, interventionId: 1, type: 'ISSUE_REPORTED', title: 'Note', message: secret('event.flaggedInternal.message'), createdAt: new Date(), createdById: 5, metadata: { internal: true } },
    ],
    quotes: [
      { id: 1, interventionId: 1, title: 'Devis', amountHT: 100, taxRate: 20, taxAmount: 20, amountTTC: 120, status: 'SENT', clientNote: 'ok', createdById: secret('quote.createdById'), createdBy: { id: 5, email: secret('quote.createdBy.email') }, items: [{ id: 1, quoteId: 1, label: 'Joint', quantity: 1, unitPrice: 100, total: 100 }] },
      { id: 2, interventionId: 1, title: secret('quote.draft.title'), amountHT: 1, taxRate: 20, taxAmount: 0, amountTTC: 1, status: 'DRAFT' },
    ],
    payments: [
      {
        id: 1,
        interventionId: 1,
        method: 'CASH',
        provider: 'MANUAL',
        status: 'CONFIRMED',
        amount: 120,
        amountRefunded: 0,
        currency: 'TND',
        reference: 'REF-1',
        clientNote: 'merci',
        adminNote: secret('payment.adminNote'),
        providerPaymentId: secret('payment.providerPaymentId'),
        createdById: secret('payment.createdById'),
        confirmedById: secret('payment.confirmedById'),
        refundedById: secret('payment.refundedById'),
        failureReason: secret('payment.failureReason'),
        refundReason: secret('payment.refundReason'),
        confirmedAt: new Date(),
      },
    ],
    invoice: {
      id: 1,
      interventionId: 1,
      invoiceNumber: 'F-2026-1',
      status: 'SENT',
      paymentStatus: 'PAID',
      clientName: 'Salah',
      clientEmail: 'salah@example.tn',
      clientPhone: '+21620000000',
      clientAddress: '12 rue de Marseille',
      amountHT: 100,
      taxRate: 20,
      taxAmount: 20,
      amountTTC: 120,
      emailedTo: secret('invoice.emailedTo'),
      cancelReason: secret('invoice.cancelReason'),
      items: [{ id: 1, invoiceId: 1, label: 'Joint', quantity: 1, unitPrice: 100, total: 100 }],
    },
    review: { id: 1, interventionId: 1, clientId: 10, artisanId: 20, rating: 5, comment: 'super', moderationReason: secret('review.moderationReason'), moderatedById: secret('review.moderatedById'), status: 'APPROVED', isVisible: true },
    complaints: [
      {
        id: 1,
        interventionId: 1,
        userId: 10,
        title: 'Retard',
        description: 'Arrivé tard',
        status: 'IN_REVIEW',
        adminNotes: secret('complaint.adminNotes'),
        internalNotes: secret('complaint.internalNotes'),
        adminDecisionNote: secret('complaint.adminDecisionNote'),
        adminDecisionById: secret('complaint.adminDecisionById'),
        refundDecidedById: secret('complaint.refundDecidedById'),
        assignedToId: secret('complaint.assignedToId'),
        assignedTo: { id: 5, email: secret('complaint.assignedTo.email') },
      },
    ],
    messages: [
      { id: 1, interventionId: 1, senderId: 20, audience: 'CLIENT_ARTISAN', content: 'J’arrive', attachments: [], isRead: false, readByUserIds: [secret('message.readByUserIds')] as any, createdAt: new Date(), sender: { id: 20, name: 'Ali', role: 'ARTISAN', email: secret('sender.email') } },
      { id: 2, interventionId: 1, senderId: 5, audience: 'CLIENT_SUPPORT', content: 'Bonjour, ici le support', attachments: [], isRead: false, readByUserIds: [], createdAt: new Date(), sender: { id: 5, name: 'Support', role: 'SUPPORT', email: secret('sender.email') } },
      { id: 3, interventionId: 1, senderId: 5, audience: 'ARTISAN_SUPPORT', content: 'Pour l’artisan seulement', attachments: [], isRead: false, readByUserIds: [], createdAt: new Date(), sender: { id: 5, name: 'Support', role: 'SUPPORT', email: secret('sender.email') } },
      { id: 4, interventionId: 1, senderId: 5, audience: 'INTERNAL_ADMIN', content: secret('message.internalAdmin.content'), attachments: [], isRead: false, readByUserIds: [], createdAt: new Date(), sender: { id: 5, name: 'Support', role: 'SUPPORT', email: secret('sender.email') } },
      { id: 5, interventionId: 1, senderId: 20, audience: 'CLIENT_ARTISAN', content: secret('message.deleted.content'), attachments: [], isRead: false, readByUserIds: [], deletedAt: new Date(), createdAt: new Date(), sender: { id: 20, name: 'Ali', role: 'ARTISAN', email: secret('sender.email') } },
    ],
    ...overrides,
  };
}

/** The names of the secrets of the job columns that this viewer may not read. */
export function jobSecretsHiddenFrom(viewer: Viewer): string[] {
  const allowed = new Set(interventionColumnsFor(viewer));

  return Object.keys(INTERVENTION_COLUMNS)
    .filter((column) => !allowed.has(column))
    .map((column) => `job.${column}`);
}

/**
 * The secrets in `value` that this viewer may not read: any planted secret that is not a job column
 * the table gives to the viewer. Empty means the answer is clean.
 */
export function leakedTo(value: unknown, viewer: Viewer, alsoTheirs: string[] = []): string[] {
  const allowed = new Set([...interventionColumnsFor(viewer).map((column) => `job.${column}`), ...alsoTheirs]);

  // The artisan who has the job reads their own account whole.
  if (viewer === 'artisan') allowed.add('artisan.email');

  return leaked(value).filter((name) => !allowed.has(name));
}

// ==========================================================
// What the routes of quotes, payments, invoices, reviews, files and complaints read
// ==========================================================

/**
 * The job as the `include` of a quote, a payment, an invoice or a receipt reads it: every column
 * of the job (a secret in each one the reader may not have), the customer and the artisan with
 * their contact columns, the service, and none of the lists.
 */
export function nestedJob(overrides: Record<string, unknown> = {}): Record<string, any> {
  const { events, quotes, payments, invoice, review, complaints, messages, ...job } = poisonedJob(overrides);

  return job;
}

export function poisonedQuote(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 1,
    interventionId: 1,
    createdById: secret('quote.createdById'),
    createdBy: { id: 5, name: 'Sam', email: secret('quote.createdBy.email'), phone: secret('quote.createdBy.phone'), role: 'SUPPORT' },
    title: 'Devis',
    description: 'Remplacement du joint',
    amountHT: 100,
    taxRate: 20,
    taxAmount: 20,
    amountTTC: 120,
    status: 'SENT',
    clientNote: null,
    pdfUrl: null,
    expiresAt: null,
    items: [{ id: 1, quoteId: 1, label: 'Joint', quantity: 1, unitPrice: 100, total: 100 }],
    intervention: nestedJob(),
    createdAt: new Date('2026-10-02T10:00:00Z'),
    updatedAt: new Date('2026-10-02T10:00:00Z'),
    ...overrides,
  };
}

export function poisonedInvoice(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 1,
    interventionId: 1,
    invoiceNumber: 'F-2026-1',
    status: 'SENT',
    paymentStatus: 'PAID',
    companyName: 'Smart-Dépannage',
    clientName: 'Salah',
    clientEmail: secret('invoice.clientEmail'),
    clientPhone: secret('invoice.clientPhone'),
    clientAddress: secret('invoice.clientAddress'),
    amountHT: 100,
    taxRate: 20,
    taxAmount: 20,
    amountTTC: 120,
    emailedTo: secret('invoice.emailedTo'),
    cancelReason: secret('invoice.cancelReason'),
    items: [{ id: 1, invoiceId: 1, label: 'Joint', quantity: 1, unitPrice: 100, total: 100 }],
    ...('payments' in overrides ? {} : { payments: [poisonedPayment({ intervention: undefined, quote: undefined, invoice: undefined })] }),
    intervention: nestedJob(),
    ...overrides,
  };
}

export function poisonedPayment(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 1,
    interventionId: 1,
    quoteId: 1,
    invoiceId: 1,
    method: 'CASH',
    provider: 'MANUAL',
    status: 'PAID',
    amount: 120,
    amountRefunded: 0,
    currency: 'TND',
    reference: 'REF-1',
    clientNote: 'merci',
    adminNote: secret('payment.adminNote'),
    providerPaymentId: secret('payment.providerPaymentId'),
    createdById: secret('payment.createdById'),
    confirmedById: secret('payment.confirmedById'),
    refundedById: secret('payment.refundedById'),
    failureReason: secret('payment.failureReason'),
    refundReason: secret('payment.refundReason'),
    confirmedAt: new Date('2026-10-03T10:00:00Z'),
    createdAt: new Date('2026-10-03T09:00:00Z'),
    intervention: nestedJob(),
    ...('quote' in overrides ? {} : { quote: poisonedQuote({ intervention: undefined, createdBy: undefined }) }),
    ...('invoice' in overrides ? {} : { invoice: poisonedInvoice({ intervention: undefined, payments: undefined }) }),
    ...overrides,
  };
}

export function poisonedReview(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 1,
    interventionId: 1,
    clientId: 10,
    artisanId: 20,
    rating: 5,
    comment: 'Très bien',
    isOnTime: true,
    status: 'APPROVED',
    isVisible: true,
    moderationReason: secret('review.moderationReason'),
    moderatedById: secret('review.moderatedById'),
    moderatedAt: new Date('2026-10-04T10:00:00Z'),
    client: { id: 10, name: 'Salah', email: secret('review.client.email'), phone: secret('review.client.phone'), address: secret('review.client.address') },
    artisan: {
      id: 20,
      name: 'Ali',
      email: secret('review.artisan.email'),
      phone: '+21621111111',
      artisanProfile: { specialty: 'PLUMBING', averageRating: 4.8, ratingCount: 12 },
    },
    intervention: {
      id: 1,
      description: secret('job.description'),
      address: secret('job.address'),
      serviceType: 'PLUMBING',
      status: 'COMPLETED',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      workCompletedAt: new Date('2026-10-02T10:00:00Z'),
      paidAt: new Date('2026-10-03T10:00:00Z'),
    },
    createdAt: new Date('2026-10-04T09:00:00Z'),
    ...overrides,
  };
}

export function poisonedFile(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 1,
    uploadedById: 5,
    uploadedBy: { id: 5, name: 'Sam', email: secret('file.uploadedBy.email'), role: 'SUPPORT' },
    purpose: 'CLIENT_DAMAGE_PHOTO',
    visibility: 'PRIVATE',
    storageProvider: secret('file.storageProvider'),
    entityType: 'INTERVENTION',
    entityId: 1,
    originalName: 'fuite.jpg',
    fileName: secret('file.fileName'),
    relativePath: secret('file.relativePath'),
    publicUrl: null,
    mimeType: 'image/jpeg',
    extension: 'jpg',
    size: 1234,
    checksum: secret('file.checksum'),
    isImage: true,
    isDeleted: false,
    deletedAt: null,
    replacedById: secret('file.replacedById'),
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

export function poisonedComplaint(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 1,
    interventionId: 1,
    userId: 10,
    assignedToId: secret('complaint.assignedToId'),
    title: 'Retard',
    description: 'Arrivé tard',
    status: 'IN_REVIEW',
    adminNotes: secret('complaint.adminNotes'),
    internalNotes: secret('complaint.internalNotes'),
    adminDecisionNote: secret('complaint.adminDecisionNote'),
    adminDecisionById: secret('complaint.adminDecisionById'),
    refundDecidedById: secret('complaint.refundDecidedById'),
    resolutionNotes: 'Remboursement partiel',
    user: { id: 10, name: 'Salah', email: secret('complaint.user.email'), phone: secret('complaint.user.phone'), role: 'CLIENT' },
    assignedTo: { id: 5, name: 'Sam', email: secret('complaint.assignedTo.email'), phone: secret('complaint.assignedTo.phone'), role: 'SUPPORT' },
    intervention: {
      id: 1,
      description: secret('job.description'),
      address: secret('job.address'),
      serviceType: 'PLUMBING',
      status: 'COMPLETED',
      urgency: 'NORMAL',
      clientId: 10,
      artisanId: 20,
      contactName: secret('job.contactName'),
      contactPhone: secret('job.contactPhone'),
      createdAt: new Date('2026-10-01T10:00:00Z'),
    },
    messages: [
      { id: 1, complaintId: 1, senderId: 10, senderRole: 'CLIENT', content: 'Il est arrivé tard', attachments: [], isInternal: false, deletedAt: null, sender: { id: 10, name: 'Salah', email: secret('complaint.sender.email'), phone: secret('complaint.sender.phone'), role: 'CLIENT' } },
      { id: 2, complaintId: 1, senderId: 5, senderRole: 'SUPPORT', content: 'Nous regardons', attachments: [], isInternal: false, deletedAt: null, sender: { id: 5, name: 'Sam', email: secret('complaint.sender.email'), phone: secret('complaint.sender.phone'), role: 'SUPPORT' } },
      { id: 3, complaintId: 1, senderId: 5, senderRole: 'SUPPORT', content: secret('complaint.internalMessage.content'), attachments: [], isInternal: true, deletedAt: null, sender: { id: 5, name: 'Sam', email: secret('complaint.sender.email'), phone: secret('complaint.sender.phone'), role: 'SUPPORT' } },
      { id: 4, complaintId: 1, senderId: 10, senderRole: 'CLIENT', content: secret('complaint.deletedMessage.content'), attachments: [], isInternal: false, deletedAt: new Date(), sender: { id: 10, name: 'Salah', email: secret('complaint.sender.email'), phone: secret('complaint.sender.phone'), role: 'CLIENT' } },
    ],
    createdAt: new Date('2026-10-05T10:00:00Z'),
    ...overrides,
  };
}
