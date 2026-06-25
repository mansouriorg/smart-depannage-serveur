import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from './realtime.gateway';

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

    this.gateway.emitStatusChange(payload);

    this.gateway.emitToClient(
      intervention.clientId,
      'intervention.status.changed',
      payload,
    );

    if (intervention.artisanId) {
      this.gateway.emitToArtisan(
        intervention.artisanId,
        'intervention.status.changed',
        payload,
      );
    }

    return payload;
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

    this.gateway.emitToIntervention(
      message.interventionId,
      'message.created',
      payload,
    );

    this.gateway.emitToClient(
      message.intervention.clientId,
      'message.created',
      payload,
    );

    if (message.intervention.artisanId) {
      this.gateway.emitToArtisan(
        message.intervention.artisanId,
        'message.created',
        payload,
      );
    }

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

    this.gateway.emitToIntervention(
      complaint.interventionId,
      'complaint.alert',
      payload,
    );

    if (complaint.userId) {
      this.gateway.emitToUser(
        complaint.userId,
        'complaint.alert',
        payload,
      );
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

    this.gateway.emitToIntervention(
      payment.interventionId,
      'payment.confirmed',
      payload,
    );

    this.gateway.emitToClient(
      payment.intervention.clientId,
      'payment.confirmed',
      payload,
    );

    if (payment.intervention.artisanId) {
      this.gateway.emitToArtisan(
        payment.intervention.artisanId,
        'payment.confirmed',
        payload,
      );
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

    this.gateway.emitToIntervention(
      quote.interventionId,
      'quote.accepted',
      payload,
    );

    this.gateway.emitToClient(
      quote.intervention.clientId,
      'quote.accepted',
      payload,
    );

    if (quote.intervention.artisanId) {
      this.gateway.emitToArtisan(
        quote.intervention.artisanId,
        'quote.accepted',
        payload,
      );
    }

    return payload;
  }
}