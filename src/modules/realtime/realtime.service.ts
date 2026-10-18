import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from './realtime.gateway';
import { chatParties } from '../messages/message-audience';
import {
  artisanPositionIsShared,
  complaintForClient,
  interventionForArtisan,
  interventionForClient,
  interventionForRoom,
  messageForParties,
  paymentForArtisan,
  paymentForClient,
  quoteForParties,
} from '../../common/views/views';

import {
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class RealtimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
  ) {}

  // ==========================================================
  // 1. New intervention in admin dashboard
  // ==========================================================

  async emitNewIntervention(interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        subService: true,
      },
    });

    if (!intervention) {
      return null;
    }

    const payload = {
      event: 'admin.intervention.created',
      intervention,
      interventionId: intervention.id,
      serviceType: intervention.serviceType,
      status: intervention.status,
      urgency: intervention.urgency,
      address: intervention.address,
      clientId: intervention.clientId,
      artisanId: intervention.artisanId,
      createdAt: intervention.createdAt,
    };

    this.gateway.emitToAdmins('admin.intervention.created', payload);

    return payload;
  }

  // ==========================================================
  // 2. Status change
  // ==========================================================

  async emitStatusChange(params: {
    interventionId: number;
    oldStatus?: Status | string | null;
    newStatus: Status | string;
    actorId?: number;
  }) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: params.interventionId,
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    if (!intervention) {
      return null;
    }

    const payload = {
      event: 'intervention.status.changed',
      interventionId: params.interventionId,
      oldStatus: params.oldStatus,
      newStatus: params.newStatus,
      actorId: params.actorId,
      intervention,
      changedAt: new Date(),
    };

    // Only the dashboard gets the whole row, with the id of whoever made the change (when an
    // artisan gives a job back, the client must not learn who it was). Everybody else gets a copy
    // of their own (P1-08): the customer their job (the artisan's name and number, nobody's
    // e-mail), the artisan theirs (the customer to call), and the room of the job, where the
    // customer, the artisan and the back office all sit, only the status and the dates.
    const { actorId: _whoActed, intervention: _whole, ...base } = payload;

    this.gateway.emitToIntervention(params.interventionId, 'intervention.status.changed', {
      ...base,
      intervention: interventionForRoom(intervention),
    });
    this.gateway.emitToAdmins('admin.intervention.status.changed', payload);

    this.gateway.emitToClient(intervention.clientId, 'intervention.status.changed', {
      ...base,
      intervention: interventionForClient(intervention),
    });

    if (intervention.artisanId) {
      this.gateway.emitToArtisan(intervention.artisanId, 'intervention.status.changed', {
        ...base,
        intervention: interventionForArtisan(intervention),
      });
    }

    return payload;
  }

  // ==========================================================
  // 2b. The artisan is no longer on the job
  // ==========================================================

  /** The artisan stops receiving what is said about the job (it was given back, or given to somebody else). */
  removeFromJobRoom(userId: number, interventionId: number) {
    this.gateway.removeUserFromIntervention(userId, interventionId);
  }

  // ==========================================================
  // 3. Artisan location update
  // Can be called from REST services too
  // ==========================================================

  async emitArtisanLocationUpdate(params: {
    interventionId: number;
    artisanId: number;
    latitude: number;
    longitude: number;
    accuracy?: number;
    heading?: number;
    speed?: number;
  }) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: params.interventionId,
      },
      select: {
        id: true,
        clientId: true,
        artisanId: true,
        status: true,
      },
    });

    if (!intervention) {
      return null;
    }

    const payload = {
      event: 'artisan.location.updated',
      interventionId: params.interventionId,
      artisanId: params.artisanId,
      latitude: params.latitude,
      longitude: params.longitude,
      accuracy: params.accuracy,
      heading: params.heading,
      speed: params.speed,
      status: intervention.status,
      updatedAt: new Date(),
    };

    // The customer (and the room of the job) read the artisan's position only while the artisan
    // is on the way; the back office follows it all the time (P1-08).
    if (artisanPositionIsShared(intervention.status)) {
      this.gateway.emitToIntervention(
        params.interventionId,
        'artisan.location.updated',
        payload,
      );

      this.gateway.emitToClient(
        intervention.clientId,
        'artisan.location.updated',
        payload,
      );
    }

    this.gateway.emitToAdmins('admin.artisan.location.updated', payload);

    return payload;
  }

  // ==========================================================
  // 4. New message
  // ==========================================================

  async emitNewMessage(messageId: number) {
    const message = await this.prisma.message.findUnique({
      where: {
        id: messageId,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        intervention: {
          select: {
            id: true,
            clientId: true,
            artisanId: true,
            status: true,
          },
        },
      },
    });

    if (!message) {
      return null;
    }

    const payload = {
      event: 'message.created',
      messageId: message.id,
      interventionId: message.interventionId,
      audience: message.audience,
      content: message.content,
      attachments: message.attachments,
      sender: message.sender,
      createdAt: message.createdAt,
      message,
    };

    // Route by audience: a message goes to the people in that chat and nobody
    // else. It used to go to the intervention room, the client AND the artisan
    // whatever the audience, so a support message to the customer reached the
    // artisan and the reverse. (The intervention room is not used for messages:
    // everybody in it would see every chat.)
    //
    // The customer and the artisan get the message without the writer's e-mail and without the ids
    // of the others who read it (P1-08); the dashboard gets the row as it is.
    const parties = chatParties(message.audience);
    const forThePeople = {
      event: payload.event,
      messageId: message.id,
      interventionId: message.interventionId,
      audience: message.audience,
      content: message.content,
      attachments: message.attachments,
      sender: messageForParties(message).sender,
      createdAt: message.createdAt,
      message: messageForParties(message),
    };

    if (parties?.client) {
      this.gateway.emitToClient(message.intervention.clientId, 'message.created', forThePeople);
    }

    if (parties?.artisan && message.intervention.artisanId) {
      this.gateway.emitToArtisan(message.intervention.artisanId, 'message.created', forThePeople);
    }

    // The back office watches every chat from the dashboard.
    this.gateway.emitToAdmins('admin.message.created', payload);

    return payload;
  }

  // ==========================================================
  // 5. Complaint alert
  // ==========================================================

  async emitComplaintAlert(complaintId: number) {
    const complaint = await this.prisma.complaint.findUnique({
      where: {
        id: complaintId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        intervention: {
          select: {
            id: true,
            clientId: true,
            artisanId: true,
            status: true,
            serviceType: true,
            address: true,
          },
        },
      },
    });

    if (!complaint) {
      return null;
    }

    const payload = {
      event: 'complaint.alert',
      complaintId: complaint.id,
      interventionId: complaint.interventionId,
      title: complaint.title,
      status: complaint.status,
      userId: complaint.userId,
      complaint,
      createdAt: complaint.createdAt,
    };

    this.gateway.emitToAdmins('admin.complaint.alert', payload);

    // The room of the job (the customer, the artisan) is told that a complaint exists, not what
    // it says; the person who made it gets their complaint without the notes and the people of
    // the back office (P1-08).
    const { complaint: _whole, userId: _author, ...announcement } = payload;

    this.gateway.emitToIntervention(complaint.interventionId, 'complaint.alert', announcement);

    if (complaint.userId) {
      this.gateway.emitToUser(complaint.userId, 'complaint.alert', {
        ...announcement,
        complaint: complaintForClient(complaint),
      });
    }

    return payload;
  }

  // ==========================================================
  // 6. Payment confirmation
  // ==========================================================

  async emitPaymentConfirmation(paymentId: number) {
    const payment = await this.prisma.payment.findUnique({
      where: {
        id: paymentId,
      },
      include: {
        intervention: {
          select: {
            id: true,
            clientId: true,
            artisanId: true,
            status: true,
          },
        },
        quote: true,
        invoice: true,
      },
    });

    if (!payment) {
      return null;
    }

    const payload = {
      event: 'payment.confirmed',
      paymentId: payment.id,
      interventionId: payment.interventionId,
      quoteId: payment.quoteId,
      invoiceId: payment.invoiceId,
      amount: payment.amount,
      amountRefunded: payment.amountRefunded,
      currency: payment.currency,
      method: payment.method,
      provider: payment.provider,
      status: payment.status,
      confirmedAt: payment.confirmedAt,
      payment,
    };

    this.gateway.emitToAdmins('admin.payment.confirmed', payload);

    // The customer gets their payment (how they paid, the receipt), the artisan and the room only
    // that it was made: no reference, no provider, no note, nobody at the back office (P1-08).
    const forTheClient = {
      event: payload.event,
      paymentId: payment.id,
      interventionId: payment.interventionId,
      quoteId: payment.quoteId,
      invoiceId: payment.invoiceId,
      amount: payment.amount,
      amountRefunded: payment.amountRefunded,
      currency: payment.currency,
      method: payment.method,
      status: payment.status,
      confirmedAt: payment.confirmedAt,
      payment: paymentForClient(payment),
    };
    const forTheOthers = {
      event: payload.event,
      paymentId: payment.id,
      interventionId: payment.interventionId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      confirmedAt: payment.confirmedAt,
      payment: paymentForArtisan(payment),
    };

    this.gateway.emitToIntervention(payment.interventionId, 'payment.confirmed', forTheOthers);

    this.gateway.emitToClient(payment.intervention.clientId, 'payment.confirmed', forTheClient);

    if (payment.intervention.artisanId) {
      this.gateway.emitToArtisan(payment.intervention.artisanId, 'payment.confirmed', forTheOthers);
    }

    return payload;
  }

  // ==========================================================
  // 7. Quote accepted
  // ==========================================================

  async emitQuoteAccepted(quoteId: number) {
    const quote = await this.prisma.quote.findUnique({
      where: {
        id: quoteId,
      },
      include: {
        items: true,
        intervention: {
          select: {
            id: true,
            clientId: true,
            artisanId: true,
            status: true,
            serviceType: true,
            address: true,
          },
        },
      },
    });

    if (!quote) {
      return null;
    }

    const payload = {
      event: 'quote.accepted',
      quoteId: quote.id,
      interventionId: quote.interventionId,
      amountHT: quote.amountHT,
      taxRate: quote.taxRate,
      taxAmount: quote.taxAmount,
      amountTTC: quote.amountTTC,
      status: quote.status,
      quote,
      acceptedAt: quote.acceptedAt || new Date(),
    };

    this.gateway.emitToAdmins('admin.quote.accepted', payload);

    // The customer gets the quote as they see it; the artisan and the room the amounts and the
    // status (P1-08): not who wrote the quote, not the customer's note on it.
    const forTheOthers = {
      event: payload.event,
      quoteId: quote.id,
      interventionId: quote.interventionId,
      amountHT: quote.amountHT,
      taxRate: quote.taxRate,
      taxAmount: quote.taxAmount,
      amountTTC: quote.amountTTC,
      status: quote.status,
      acceptedAt: payload.acceptedAt,
    };

    this.gateway.emitToIntervention(quote.interventionId, 'quote.accepted', forTheOthers);

    this.gateway.emitToClient(quote.intervention.clientId, 'quote.accepted', {
      ...forTheOthers,
      quote: quoteForParties(quote),
    });

    if (quote.intervention.artisanId) {
      this.gateway.emitToArtisan(quote.intervention.artisanId, 'quote.accepted', forTheOthers);
    }

    return payload;
  }
}
