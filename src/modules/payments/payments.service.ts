import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { AdminPaymentActionDto } from './dto/admin-payment-action.dto';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import {
  InterventionEventType,
  PaymentMethod,
  PaymentStatus,
  Status,
} from '../../../generated/prisma/client';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  private async getClientIntervention(clientId: number, interventionId: number) {
    const intervention = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      include: {
        quotes: {
          where: { status: 'ACCEPTED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    if (intervention.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé.');
    }

    return intervention;
  }

  async createClientPaymentRequest(
    clientId: number,
    interventionId: number,
    dto: CreateManualPaymentDto,
  ) {
    const intervention = await this.getClientIntervention(
      clientId,
      interventionId,
    );

    const acceptedQuote = intervention.quotes[0];
    const amount = dto.amount ?? acceptedQuote?.amountTTC;

    if (!amount) {
      throw new BadRequestException(
        'Montant introuvable. Acceptez un devis ou envoyez un montant.',
      );
    }

    const status =
      dto.method === PaymentMethod.CASH ||
      dto.method === PaymentMethod.BANK_TRANSFER
        ? PaymentStatus.AWAITING_CONFIRMATION
        : PaymentStatus.PENDING;

    const payment = await this.prisma.payment.create({
      data: {
        interventionId,
        quoteId: acceptedQuote?.id,
        method: dto.method,
        status,
        amount,
        reference: dto.reference,
        clientNote: dto.clientNote,
      },
    });

    await this.prisma.intervention.update({
      where: { id: interventionId },
      data: {
        status: Status.PAYMENT_PENDING,
      },
    });

    await this.events.create({
      interventionId,
      type: InterventionEventType.PAYMENT_PENDING,
      title: 'Paiement en attente',
      message:
        dto.method === PaymentMethod.ONLINE
          ? 'Le paiement en ligne est enregistré comme demande en attente. Aucun prestataire de paiement externe n’est encore connecté.'
          : `Paiement ${dto.method} en attente de confirmation.`,
      createdById: clientId,
    });

    return {
      ...payment,
      instructions: this.getPaymentInstructions(dto.method),
    };
  }

  getPaymentInstructions(method: PaymentMethod) {
    if (method === PaymentMethod.CASH) {
      return 'Paiement en espèces à remettre à l’artisan ou à confirmer par l’administrateur.';
    }

    if (method === PaymentMethod.BANK_TRANSFER) {
      return 'Effectuez le virement bancaire puis envoyez la référence du virement. Confirmation manuelle par l’administrateur.';
    }

    return 'Paiement en ligne non connecté pour le moment. Cette demande reste en attente jusqu’à intégration d’un prestataire.';
  }

  async findForClient(clientId: number, interventionId: number) {
    await this.getClientIntervention(clientId, interventionId);

    return this.prisma.payment.findMany({
      where: { interventionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async confirm(
    paymentId: number,
    adminId: number,
    dto: AdminPaymentActionDto,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }

    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.PAID,
        confirmedAt: new Date(),
        adminNote: dto.adminNote,
      },
    });

    await this.prisma.intervention.update({
      where: { id: payment.interventionId },
      data: {
        status: Status.PAID,
      },
    });

    await this.events.create({
      interventionId: payment.interventionId,
      type: InterventionEventType.PAYMENT_CONFIRMED,
      title: 'Paiement confirmé',
      message: 'Le paiement a été confirmé.',
      createdById: adminId,
    });

    return updated;
  }

  async fail(paymentId: number, adminId: number, dto: AdminPaymentActionDto) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }

    return this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.FAILED,
        failedAt: new Date(),
        adminNote: dto.adminNote,
      },
    });
  }

  async refund(paymentId: number, adminId: number, dto: AdminPaymentActionDto) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Paiement introuvable.');
    }

    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.REFUNDED,
        refundedAt: new Date(),
        adminNote: dto.adminNote,
      },
    });

    await this.events.create({
      interventionId: payment.interventionId,
      type: InterventionEventType.PAYMENT_CONFIRMED,
      title: 'Remboursement enregistré',
      message: 'Un remboursement a été enregistré par l’administration.',
      createdById: adminId,
    });

    return updated;
  }
}