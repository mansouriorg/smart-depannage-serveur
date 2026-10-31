import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { complaintForClient, complaintMessageForParties } from '../../common/views/views';
import { NotificationsService } from '../notifications/notifications.service';
import { REFUND_NOT_ANSWERED, closeComplaintIfRefundAnswered, endsComplaint } from './complaint-closing';

import {
  ComplaintRefundDecision,
  ComplaintStatus,
  Prisma,
  Role,
} from '../../../generated/prisma/client';

import {
  AddComplaintMessageDto,
  ArtisanResponseDto,
  AssignComplaintDto,
  CreateComplaintDto,
  ResolveComplaintDto,
  UpdateComplaintStatusDto,
} from './dto/complaint.dto';
import { Permission, can, rolesWith } from '../../common/auth/permissions';

export { REFUND_NOT_ANSWERED };

@Injectable()
export class ComplaintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The back office moved a complaint forward: tell the person who filed it (never throws). */
  private async tellComplainant(
    complaint: { id: number; userId: number | null },
    actorId: number,
  ) {
    if (complaint.userId) {
      await this.notifications.notifyComplaintUpdated(
        complaint.id,
        complaint.userId,
        actorId,
      );
    }
  }

  // ==========================================================
  // Helpers
  // ==========================================================

  private isStaff(role: Role): boolean {
    return can(role, Permission.BACK_OFFICE_ACCESS);
  }

  private assertStaff(role: Role) {
    if (!this.isStaff(role)) {
      throw new ForbiddenException('Accès réservé à l’administration.');
    }
  }

  private complaintInclude() {
    return {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
        },
      },
      assignedTo: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
        },
      },
      intervention: {
        select: {
          id: true,
          description: true,
          address: true,
          serviceType: true,
          status: true,
          urgency: true,
          clientId: true,
          artisanId: true,
          contactName: true,
          contactPhone: true,
          createdAt: true,
        },
      },
      messages: {
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              role: true,
            },
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
      },
    } satisfies Prisma.ComplaintInclude;
  }

  /**
   * The complaint as the customer or the artisan of the job reads it (P1-08): the decision and the
   * public thread, with the people as names. The notes, the staff member who handles it, the
   * internal messages and every address and number stay with the back office.
   */
  private removeInternalFieldsForNonStaff(complaint: any) {
    return complaintForClient(complaint);
  }

  private formatComplaintForUser(complaint: any, role: Role) {
    if (this.isStaff(role)) {
      return complaint;
    }

    return this.removeInternalFieldsForNonStaff(complaint);
  }

  private async getInterventionOrFail(interventionId: number) {
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
            role: true,
          },
        },
        artisan: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        },
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    return intervention;
  }

  private async getComplaintOrFail(complaintId: number) {
    const complaint = await this.prisma.complaint.findUnique({
      where: {
        id: complaintId,
      },
      include: this.complaintInclude(),
    });

    if (!complaint) {
      throw new NotFoundException('Réclamation introuvable.');
    }

    return complaint;
  }

  private async checkInterventionAccess(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    const intervention = await this.getInterventionOrFail(interventionId);

    const isClient = intervention.clientId === userId;
    const isArtisan = intervention.artisanId === userId;
    const isStaff = this.isStaff(role);

    if (!isClient && !isArtisan && !isStaff) {
      throw new ForbiddenException('Accès refusé.');
    }

    return intervention;
  }

  private async checkComplaintAccess(
    userId: number,
    role: Role,
    complaintId: number,
  ) {
    const complaint = await this.getComplaintOrFail(complaintId);

    const isClient = complaint.intervention.clientId === userId;
    const isArtisan = complaint.intervention.artisanId === userId;
    const isAuthor = complaint.userId === userId;
    const isStaff = this.isStaff(role);

    if (!isClient && !isArtisan && !isAuthor && !isStaff) {
      throw new ForbiddenException('Accès refusé.');
    }

    return complaint;
  }

  private async assertAssignableSupportUser(userId: number) {
    const supportUser = await this.prisma.user.findFirst({
      where: {
        id: userId,
        isActive: true,
        deletedAt: null,
        role: { in: rolesWith(Permission.COMPLAINTS_ASSIGNEE) },
      },
    });

    if (!supportUser) {
      throw new NotFoundException(
        'Agent support/admin introuvable ou inactif.',
      );
    }

    return supportUser;
  }

  private statusDateFields(status: ComplaintStatus) {
    if (status === ComplaintStatus.RESOLVED) {
      return {
        resolvedAt: new Date(),
        closedAt: new Date(),
      };
    }

    if (status === ComplaintStatus.REJECTED) {
      return {
        rejectedAt: new Date(),
        closedAt: new Date(),
      };
    }

    if (status === ComplaintStatus.REFUNDED) {
      return {
        resolvedAt: new Date(),
        closedAt: new Date(),
      };
    }

    return {};
  }

  // ==========================================================
  // Client / Artisan: create complaint
  // ==========================================================

  async createComplaint(
    userId: number,
    role: Role,
    interventionId: number,
    dto: CreateComplaintDto,
    options: {
      /**
       * Leave `Intervention.feedbackNotes` alone. By default it is replaced by the
       * complaint's title; a report from a tracking link (no account) must not
       * overwrite what the request already holds.
       */
      keepFeedbackNotes?: boolean;
    } = {},
  ) {
    const intervention = await this.checkInterventionAccess(
      userId,
      role,
      interventionId,
    );

    if (role !== Role.CLIENT && role !== Role.ARTISAN && !this.isStaff(role)) {
      throw new ForbiddenException(
        'Seul un client, un artisan ou un admin peut créer une réclamation.',
      );
    }

    const photos = dto.photos || [];
    const attachments = dto.attachments || [];

    const complaint = await this.prisma.complaint.create({
      data: {
        interventionId,
        userId,
        title: dto.title.trim(),
        description: dto.description.trim(),
        clientMessage: role === Role.CLIENT ? dto.description.trim() : null,
        photos,
        attachments,
        refundRequested: dto.refundRequested ?? false,
        refundDecision: dto.refundRequested
          ? ComplaintRefundDecision.PENDING
          : ComplaintRefundDecision.NOT_REQUESTED,
        status: ComplaintStatus.OPEN,
        messages: {
          create: {
            senderId: userId,
            senderRole: role,
            content: dto.description.trim(),
            attachments: [...photos, ...attachments],
            isInternal: false,
          },
        },
      },
      include: this.complaintInclude(),
    });

    await this.prisma.intervention
      .update({
        where: {
          id: intervention.id,
        },
        data: options.keepFeedbackNotes
          ? { hasIssue: true }
          : {
              hasIssue: true,
              feedbackNotes: dto.title.trim(),
            },
      })
      .catch(() => null);

    // Each support admin gets their own notification (never throws).
    await this.notifications.notifyComplaintOpened(complaint.id, userId);

    return this.formatComplaintForUser(complaint, role);
  }

  // ==========================================================
  // General complaint access
  // ==========================================================

  async findOne(userId: number, role: Role, complaintId: number) {
    const complaint = await this.checkComplaintAccess(
      userId,
      role,
      complaintId,
    );

    return this.formatComplaintForUser(complaint, role);
  }

  async findByIntervention(
    userId: number,
    role: Role,
    interventionId: number,
  ) {
    await this.checkInterventionAccess(userId, role, interventionId);

    const complaints = await this.prisma.complaint.findMany({
      where: {
        interventionId,
      },
      include: this.complaintInclude(),
      orderBy: {
        createdAt: 'desc',
      },
    });

    return complaints.map((complaint) =>
      this.formatComplaintForUser(complaint, role),
    );
  }

  async findMyComplaints(userId: number, role: Role) {
    if (this.isStaff(role)) {
      return this.newestForStaff(role);
    }

    const where: Prisma.ComplaintWhereInput =
      role === Role.CLIENT
        ? {
            OR: [
              {
                userId,
              },
              {
                intervention: {
                  clientId: userId,
                },
              },
            ],
          }
        : {
            OR: [
              {
                userId,
              },
              {
                intervention: {
                  artisanId: userId,
                },
              },
            ],
          };

    const complaints = await this.prisma.complaint.findMany({
      where,
      include: this.complaintInclude(),
      orderBy: {
        createdAt: 'desc',
      },
    });

    return complaints.map((complaint) =>
      this.formatComplaintForUser(complaint, role),
    );
  }

  // ==========================================================
  // Messages / discussion
  // ==========================================================

  async addMessage(
    userId: number,
    role: Role,
    complaintId: number,
    dto: AddComplaintMessageDto,
  ) {
    const complaint = await this.checkComplaintAccess(
      userId,
      role,
      complaintId,
    );

    const isInternal = dto.isInternal ?? false;

    if (isInternal && !this.isStaff(role)) {
      throw new ForbiddenException(
        'Seule l’administration peut ajouter un message interne.',
      );
    }

    const message = await this.prisma.complaintMessage.create({
      data: {
        complaintId,
        senderId: userId,
        senderRole: role,
        content: dto.content.trim(),
        attachments: dto.attachments || [],
        isInternal,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        },
      },
    });

    if (!isInternal) {
      let nextStatus = complaint.status;

      if (role === Role.CLIENT) {
        nextStatus = ComplaintStatus.WAITING_ARTISAN;
      }

      if (role === Role.ARTISAN) {
        nextStatus = ComplaintStatus.WAITING_CLIENT;
      }

      if (this.isStaff(role)) {
        nextStatus = ComplaintStatus.IN_REVIEW;
      }

      await this.prisma.complaint.update({
        where: {
          id: complaintId,
        },
        data: {
          status: nextStatus,
        },
      });

      if (this.isStaff(role)) {
        await this.tellComplainant(complaint, userId);
      } else {
        await this.notifications.notifyComplaintReply(complaintId, userId);
      }
    }

    return this.isStaff(role) ? message : complaintMessageForParties(message);
  }

  async artisanResponse(
    userId: number,
    role: Role,
    complaintId: number,
    dto: ArtisanResponseDto,
  ) {
    const complaint = await this.checkComplaintAccess(
      userId,
      role,
      complaintId,
    );

    const isAssignedArtisan = complaint.intervention.artisanId === userId;

    if (role !== Role.ARTISAN && !this.isStaff(role)) {
      throw new ForbiddenException(
        'Seul l’artisan assigné ou l’administration peut répondre.',
      );
    }

    if (role === Role.ARTISAN && !isAssignedArtisan) {
      throw new ForbiddenException(
        'Vous ne pouvez répondre qu’aux réclamations de vos interventions.',
      );
    }

    const message = await this.prisma.complaintMessage.create({
      data: {
        complaintId,
        senderId: userId,
        senderRole: role,
        content: dto.response.trim(),
        attachments: dto.attachments || [],
        isInternal: false,
      },
    });

    const updated = await this.prisma.complaint.update({
      where: {
        id: complaintId,
      },
      data: {
        artisanResponse: dto.response.trim(),
        artisanRespondedAt: new Date(),
        status: ComplaintStatus.IN_REVIEW,
      },
      include: this.complaintInclude(),
    });

    if (this.isStaff(role)) {
      await this.tellComplainant(updated, userId);
    } else {
      await this.notifications.notifyComplaintReply(complaintId, userId);
    }

    return {
      message: this.isStaff(role) ? message : complaintMessageForParties(message),
      complaint: this.formatComplaintForUser(updated, role),
    };
  }

  // ==========================================================
  // Admin / Support
  // ==========================================================

  // What a back-office account sees on GET /complaints/me: the fifty newest. (The route with filters and pages, GET /complaints/admin, was
  // deleted in P3-03; the dashboard reads the list from GET /admin/complaints.)
  private async newestForStaff(role: Role) {
    this.assertStaff(role);

    const take = 50;
    const skip = 0;

    const [items, total] = await Promise.all([
      this.prisma.complaint.findMany({
        where: {},
        include: this.complaintInclude(),
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take,
      }),
      this.prisma.complaint.count({
        where: {},
      }),
    ]);

    return {
      total,
      skip,
      take,
      items,
    };
  }

  async assignComplaint(
    userId: number,
    role: Role,
    complaintId: number,
    dto: AssignComplaintDto,
  ) {
    this.assertStaff(role);

    await this.getComplaintOrFail(complaintId);
    await this.assertAssignableSupportUser(dto.assignedToId);

    const updated = await this.prisma.complaint.update({
      where: {
        id: complaintId,
      },
      data: {
        assignedToId: dto.assignedToId,
        status: ComplaintStatus.IN_REVIEW,
      },
      include: this.complaintInclude(),
    });

    await this.notifications.notifyComplaintAssigned(
      complaintId,
      dto.assignedToId,
      userId,
    );

    return updated;
  }

  async updateStatus(
    userId: number,
    role: Role,
    complaintId: number,
    dto: UpdateComplaintStatusDto,
  ) {
    this.assertStaff(role);

    await this.getComplaintOrFail(complaintId);

    const data = {
      status: dto.status,
      ...(dto.note
        ? {
            adminNotes: dto.note.trim(),
          }
        : {}),
      ...this.statusDateFields(dto.status),
    };

    // Rejecting, resolving and refunding end the complaint (P2-09): not while the refund the customer asked for waits.
    if (endsComplaint(dto.status)) {
      await closeComplaintIfRefundAnswered(this.prisma, complaintId, data);
    } else {
      await this.prisma.complaint.update({ where: { id: complaintId }, data });
    }

    const updated = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
      include: this.complaintInclude(),
    });

    await this.tellComplainant(updated, userId);

    return updated;
  }

  async resolveComplaint(
    userId: number,
    role: Role,
    complaintId: number,
    dto: ResolveComplaintDto,
  ) {
    this.assertStaff(role);

    await this.getComplaintOrFail(complaintId);

    await closeComplaintIfRefundAnswered(this.prisma, complaintId, {
      status: ComplaintStatus.RESOLVED,
      resolutionNotes: dto.resolutionNotes.trim(),
      resolvedAt: new Date(),
      closedAt: new Date(),
    });

    const updated = await this.prisma.complaint.findUnique({
      where: { id: complaintId },
      include: this.complaintInclude(),
    });

    await this.tellComplainant(updated, userId);

    return updated;
  }
}
