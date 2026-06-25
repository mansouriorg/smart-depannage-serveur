import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import sharp from 'sharp';

import { PrismaService } from '../../prisma/prisma.service';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';

import {
  ArtisanDocumentStatus,
  ArtisanDocumentType,
  FileAssetPurpose,
  FileAssetVisibility,
  InterventionEventType,
  Prisma,
  Role,
  StorageProvider,
} from '../../../generated/prisma/client';

type AuthenticatedUser = {
  id: number;
  role: Role;
};

type LocalUploadOptions = {
  purpose: FileAssetPurpose;
  visibility?: FileAssetVisibility;
  entityType?: string;
  entityId?: number;
  allowedMimeTypes: string[];
  maxSizeMb: number;
  compressImage?: boolean;
};

type StoredLocalFile = {
  fileName: string;
  relativePath: string;
  publicUrl?: string;
  mimeType: string;
  extension?: string;
  size: number;
  checksum: string;
  isImage: boolean;
  width?: number;
  height?: number;
};

@Injectable()
export class FilesService {
  private readonly uploadRoot = path.join(process.cwd(), 'uploads');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InterventionEventsService,
  ) {}

  // ==========================================================
  // Allowed file types
  // ==========================================================

  private readonly imageMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
  ];

  private readonly pdfMimeTypes = ['application/pdf'];

  private readonly documentMimeTypes = [
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
  ];

  // ==========================================================
  // Helpers
  // ==========================================================

  private isAdminRole(role: Role): boolean {
    const adminRoles: Role[] = [
      Role.ADMIN,
      Role.SUPER_ADMIN,
      Role.SUPPORT,
      Role.DISPATCHER,
      Role.ACCOUNTANT,
    ];

    return adminRoles.includes(role);
  }

  private isImage(mimeType: string): boolean {
    return this.imageMimeTypes.includes(mimeType);
  }

  private extensionFromMimeType(mimeType: string): string {
    switch (mimeType) {
      case 'image/jpeg':
      case 'image/jpg':
        return '.jpg';

      case 'image/png':
        return '.png';

      case 'image/webp':
        return '.webp';

      case 'application/pdf':
        return '.pdf';

      default:
        return '';
    }
  }

  private safeFolderName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private generateSecureFileName(mimeType: string): string {
    const extension = this.extensionFromMimeType(mimeType);
    const random = crypto.randomBytes(24).toString('hex');

    return `${Date.now()}-${random}${extension}`;
  }

  private async ensureDir(dir: string) {
    await fs.mkdir(dir, {
      recursive: true,
    });
  }

  private checksum(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  private validateFile(
    file: Express.Multer.File,
    allowedMimeTypes: string[],
    maxSizeMb: number,
  ) {
    if (!file) {
      throw new BadRequestException('Aucun fichier envoyé.');
    }

    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Type de fichier non autorisé: ${file.mimetype}.`,
      );
    }

    const maxSizeBytes = maxSizeMb * 1024 * 1024;

    if (file.size > maxSizeBytes) {
      throw new BadRequestException(
        `Fichier trop volumineux. Taille maximale: ${maxSizeMb} MB.`,
      );
    }

    if (!file.buffer?.length) {
      throw new BadRequestException('Le fichier est vide ou invalide.');
    }
  }

  private async processImageIfNeeded(
    file: Express.Multer.File,
    compressImage: boolean,
  ): Promise<{
    buffer: Buffer;
    mimeType: string;
    width?: number;
    height?: number;
  }> {
    if (!this.isImage(file.mimetype)) {
      return {
        buffer: file.buffer,
        mimeType: file.mimetype,
      };
    }

    const metadata = await sharp(file.buffer).metadata();

    if (!compressImage) {
      return {
        buffer: file.buffer,
        mimeType: file.mimetype,
        width: metadata.width,
        height: metadata.height,
      };
    }

    const compressed = await sharp(file.buffer)
      .rotate()
      .resize({
        width: 1600,
        withoutEnlargement: true,
      })
      .webp({
        quality: 82,
      })
      .toBuffer();

    const compressedMetadata = await sharp(compressed).metadata();

    return {
      buffer: compressed,
      mimeType: 'image/webp',
      width: compressedMetadata.width,
      height: compressedMetadata.height,
    };
  }

  private async storeLocalFile(
    file: Express.Multer.File,
    options: LocalUploadOptions,
  ): Promise<StoredLocalFile> {
    this.validateFile(file, options.allowedMimeTypes, options.maxSizeMb);

    const visibility = options.visibility || FileAssetVisibility.PRIVATE;
    const purposeFolder = this.safeFolderName(options.purpose);
    const visibilityFolder =
      visibility === FileAssetVisibility.PUBLIC ? 'public' : 'private';

    const processed = await this.processImageIfNeeded(
      file,
      options.compressImage ?? true,
    );

    const fileName = this.generateSecureFileName(processed.mimeType);
    const relativePath = path.join(visibilityFolder, purposeFolder, fileName);
    const absolutePath = path.join(this.uploadRoot, relativePath);

    await this.ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, processed.buffer);

    const normalizedRelativePath = relativePath.replace(/\\/g, '/');

    const publicUrl =
      visibility === FileAssetVisibility.PUBLIC
        ? `/uploads/${normalizedRelativePath}`
        : undefined;

    return {
      fileName,
      relativePath: normalizedRelativePath,
      publicUrl,
      mimeType: processed.mimeType,
      extension: this.extensionFromMimeType(processed.mimeType),
      size: processed.buffer.length,
      checksum: this.checksum(processed.buffer),
      isImage: this.isImage(processed.mimeType),
      width: processed.width,
      height: processed.height,
    };
  }

  private absolutePathFromAsset(asset: { relativePath: string }) {
    return path.join(this.uploadRoot, asset.relativePath);
  }

  private async createFileAsset(
    user: AuthenticatedUser,
    file: Express.Multer.File,
    options: LocalUploadOptions,
  ) {
    const stored = await this.storeLocalFile(file, options);

    return this.prisma.fileAsset.create({
      data: {
        uploadedById: user.id,
        purpose: options.purpose,
        visibility: options.visibility || FileAssetVisibility.PRIVATE,
        storageProvider: StorageProvider.LOCAL,
        entityType: options.entityType,
        entityId: options.entityId,
        originalName: file.originalname || stored.fileName,
        fileName: stored.fileName,
        relativePath: stored.relativePath,
        publicUrl: stored.publicUrl,
        mimeType: stored.mimeType,
        extension: stored.extension,
        size: stored.size,
        checksum: stored.checksum,
        isImage: stored.isImage,
        width: stored.width,
        height: stored.height,
      },
    });
  }

  private async getFileAssetOrFail(fileId: number) {
    const asset = await this.prisma.fileAsset.findUnique({
      where: {
        id: fileId,
      },
      include: {
        uploadedBy: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!asset || asset.isDeleted) {
      throw new NotFoundException('Fichier introuvable.');
    }

    return asset;
  }

  private async createEvent(data: {
    interventionId: number;
    type: InterventionEventType;
    title: string;
    message?: string;
    createdById?: number;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.events.create(data);
  }

  private async checkInterventionAccess(
    user: AuthenticatedUser,
    interventionId: number,
  ) {
    const intervention = await this.prisma.intervention.findUnique({
      where: {
        id: interventionId,
      },
    });

    if (!intervention) {
      throw new NotFoundException('Intervention introuvable.');
    }

    const isAdmin = this.isAdminRole(user.role);
    const isClient = intervention.clientId === user.id;
    const isArtisan = intervention.artisanId === user.id;

    if (!isAdmin && !isClient && !isArtisan) {
      throw new ForbiddenException('Accès refusé.');
    }

    return intervention;
  }

  private async checkQuoteAccess(user: AuthenticatedUser, quoteId: number) {
    const quote = await this.prisma.quote.findUnique({
      where: {
        id: quoteId,
      },
      include: {
        intervention: true,
      },
    });

    if (!quote) {
      throw new NotFoundException('Devis introuvable.');
    }

    await this.checkInterventionAccess(user, quote.interventionId);

    return quote;
  }

  private async checkInvoiceAccess(user: AuthenticatedUser, invoiceId: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: {
        id: invoiceId,
      },
      include: {
        intervention: true,
      },
    });

    if (!invoice) {
      throw new NotFoundException('Facture introuvable.');
    }

    await this.checkInterventionAccess(user, invoice.interventionId);

    return invoice;
  }

  private async checkComplaintAccess(
    user: AuthenticatedUser,
    complaintId: number,
  ) {
    const complaint = await this.prisma.complaint.findUnique({
      where: {
        id: complaintId,
      },
      include: {
        intervention: true,
      },
    });

    if (!complaint) {
      throw new NotFoundException('Réclamation introuvable.');
    }

    const isAdmin = this.isAdminRole(user.role);
    const isOwner = complaint.userId === user.id;
    const isClient = complaint.intervention.clientId === user.id;
    const isArtisan = complaint.intervention.artisanId === user.id;

    if (!isAdmin && !isOwner && !isClient && !isArtisan) {
      throw new ForbiddenException('Accès refusé.');
    }

    return complaint;
  }

  private async checkFileAccess(user: AuthenticatedUser, asset: any) {
    if (asset.visibility === FileAssetVisibility.PUBLIC) {
      return true;
    }

    if (this.isAdminRole(user.role)) {
      return true;
    }

    if (asset.uploadedById === user.id) {
      return true;
    }

    if (asset.entityType === 'INTERVENTION' && asset.entityId) {
      await this.checkInterventionAccess(user, asset.entityId);
      return true;
    }

    if (asset.entityType === 'QUOTE' && asset.entityId) {
      await this.checkQuoteAccess(user, asset.entityId);
      return true;
    }

    if (asset.entityType === 'INVOICE' && asset.entityId) {
      await this.checkInvoiceAccess(user, asset.entityId);
      return true;
    }

    if (asset.entityType === 'COMPLAINT' && asset.entityId) {
      await this.checkComplaintAccess(user, asset.entityId);
      return true;
    }

    throw new ForbiddenException('Accès refusé à ce fichier.');
  }

  private async checkCanModifyFile(user: AuthenticatedUser, asset: any) {
    if (this.isAdminRole(user.role)) {
      return true;
    }

    if (asset.uploadedById === user.id) {
      return true;
    }

    throw new ForbiddenException('Vous ne pouvez pas modifier ce fichier.');
  }

  // ==========================================================
  // Client damage photos
  // ==========================================================

  async uploadClientDamagePhoto(
    user: AuthenticatedUser,
    interventionId: number,
    file: Express.Multer.File,
  ) {
    const intervention = await this.checkInterventionAccess(
      user,
      interventionId,
    );

    const isClient = intervention.clientId === user.id;
    const isAdmin = this.isAdminRole(user.role);

    if (!isClient && !isAdmin) {
      throw new ForbiddenException(
        'Seul le client ou l’administration peut ajouter des photos initiales.',
      );
    }

    const asset = await this.createFileAsset(user, file, {
      purpose: FileAssetPurpose.CLIENT_DAMAGE_PHOTO,
      visibility: FileAssetVisibility.PRIVATE,
      entityType: 'INTERVENTION',
      entityId: interventionId,
      allowedMimeTypes: this.imageMimeTypes,
      maxSizeMb: 8,
      compressImage: true,
    });

    await this.prisma.intervention.update({
      where: {
        id: interventionId,
      },
      data: {
        photos: {
          push: asset.publicUrl || `/files/${asset.id}/download`,
        },
      },
    });

    await this.createEvent({
      interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Photo client ajoutée',
      message: 'Une photo du problème a été ajoutée.',
      createdById: user.id,
      metadata: {
        fileId: asset.id,
        purpose: asset.purpose,
      },
    });

    return asset;
  }

  // ==========================================================
  // Artisan before photo
  // ==========================================================

  async uploadArtisanBeforePhoto(
    user: AuthenticatedUser,
    interventionId: number,
    file: Express.Multer.File,
  ) {
    const intervention = await this.checkInterventionAccess(
      user,
      interventionId,
    );

    const isAssignedArtisan = intervention.artisanId === user.id;
    const isAdmin = this.isAdminRole(user.role);

    if (!isAssignedArtisan && !isAdmin) {
      throw new ForbiddenException(
        'Seul l’artisan assigné ou l’administration peut ajouter la photo avant intervention.',
      );
    }

    const asset = await this.createFileAsset(user, file, {
      purpose: FileAssetPurpose.ARTISAN_BEFORE_PHOTO,
      visibility: FileAssetVisibility.PRIVATE,
      entityType: 'INTERVENTION',
      entityId: interventionId,
      allowedMimeTypes: this.imageMimeTypes,
      maxSizeMb: 8,
      compressImage: true,
    });

    await this.prisma.intervention.update({
      where: {
        id: interventionId,
      },
      data: {
        beforePhotoUrl: asset.publicUrl || `/files/${asset.id}/download`,
        beforePhotoAt: new Date(),
      },
    });

    await this.createEvent({
      interventionId,
      type: InterventionEventType.BEFORE_PHOTO_UPLOADED,
      title: 'Photo avant intervention ajoutée',
      message: 'L’artisan a ajouté une photo avant intervention.',
      createdById: user.id,
      metadata: {
        fileId: asset.id,
      },
    });

    return asset;
  }

  // ==========================================================
  // Artisan after photo
  // ==========================================================

  async uploadArtisanAfterPhoto(
    user: AuthenticatedUser,
    interventionId: number,
    file: Express.Multer.File,
  ) {
    const intervention = await this.checkInterventionAccess(
      user,
      interventionId,
    );

    const isAssignedArtisan = intervention.artisanId === user.id;
    const isAdmin = this.isAdminRole(user.role);

    if (!isAssignedArtisan && !isAdmin) {
      throw new ForbiddenException(
        'Seul l’artisan assigné ou l’administration peut ajouter la photo après intervention.',
      );
    }

    const asset = await this.createFileAsset(user, file, {
      purpose: FileAssetPurpose.ARTISAN_AFTER_PHOTO,
      visibility: FileAssetVisibility.PRIVATE,
      entityType: 'INTERVENTION',
      entityId: interventionId,
      allowedMimeTypes: this.imageMimeTypes,
      maxSizeMb: 8,
      compressImage: true,
    });

    await this.prisma.intervention.update({
      where: {
        id: interventionId,
      },
      data: {
        afterPhotoUrl: asset.publicUrl || `/files/${asset.id}/download`,
        afterPhotoAt: new Date(),
      },
    });

    await this.createEvent({
      interventionId,
      type: InterventionEventType.AFTER_PHOTO_UPLOADED,
      title: 'Photo après intervention ajoutée',
      message: 'L’artisan a ajouté une photo après intervention.',
      createdById: user.id,
      metadata: {
        fileId: asset.id,
      },
    });

    return asset;
  }

  // ==========================================================
  // Artisan documents
  // ==========================================================

  async uploadArtisanDocument(
    user: AuthenticatedUser,
    file: Express.Multer.File,
    type: ArtisanDocumentType,
    visibility = FileAssetVisibility.PRIVATE,
  ) {
    if (user.role !== Role.ARTISAN && !this.isAdminRole(user.role)) {
      throw new ForbiddenException(
        'Seul un artisan ou un administrateur peut ajouter un document artisan.',
      );
    }

    const artisanProfile = await this.prisma.artisanProfile.findUnique({
      where: {
        userId: user.id,
      },
    });

    if (!artisanProfile) {
      throw new NotFoundException('Profil artisan introuvable.');
    }

    const purpose =
      type === ArtisanDocumentType.IDENTITY
        ? FileAssetPurpose.IDENTITY_DOCUMENT
        : type === ArtisanDocumentType.INSURANCE
          ? FileAssetPurpose.INSURANCE_CERTIFICATE
          : FileAssetPurpose.ARTISAN_DOCUMENT;

    const asset = await this.createFileAsset(user, file, {
      purpose,
      visibility,
      entityType: 'ARTISAN_PROFILE',
      entityId: artisanProfile.id,
      allowedMimeTypes: this.documentMimeTypes,
      maxSizeMb: 12,
      compressImage: true,
    });

    const document = await this.prisma.artisanDocument.create({
      data: {
        artisanProfileId: artisanProfile.id,
        type,
        fileUrl: asset.publicUrl || `/files/${asset.id}/download`,
        fileName: asset.originalName,
        mimeType: asset.mimeType,
        status: ArtisanDocumentStatus.PENDING,
      },
    });

    return {
      asset,
      document,
    };
  }

  // ==========================================================
  // Quote PDF
  // ==========================================================

  async uploadQuotePdf(
    user: AuthenticatedUser,
    quoteId: number,
    file: Express.Multer.File,
  ) {
    const quote = await this.checkQuoteAccess(user, quoteId);

    if (!this.isAdminRole(user.role) && user.role !== Role.ARTISAN) {
      throw new ForbiddenException(
        'Seul l’administration ou un artisan peut ajouter le PDF du devis.',
      );
    }

    const asset = await this.createFileAsset(user, file, {
      purpose: FileAssetPurpose.QUOTE_PDF,
      visibility: FileAssetVisibility.PRIVATE,
      entityType: 'QUOTE',
      entityId: quoteId,
      allowedMimeTypes: this.pdfMimeTypes,
      maxSizeMb: 15,
      compressImage: false,
    });

    await this.prisma.quote.update({
      where: {
        id: quoteId,
      },
      data: {
        pdfUrl: asset.publicUrl || `/files/${asset.id}/download`,
      },
    });

    await this.createEvent({
      interventionId: quote.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'PDF du devis ajouté',
      message: 'Le PDF du devis a été ajouté.',
      createdById: user.id,
      metadata: {
        quoteId,
        fileId: asset.id,
      },
    });

    return asset;
  }

  // ==========================================================
  // Invoice PDF
  // ==========================================================

  async uploadInvoicePdf(
    user: AuthenticatedUser,
    invoiceId: number,
    file: Express.Multer.File,
  ) {
    const invoice = await this.checkInvoiceAccess(user, invoiceId);

    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException(
        'Seule l’administration peut ajouter le PDF de la facture.',
      );
    }

    const asset = await this.createFileAsset(user, file, {
      purpose: FileAssetPurpose.INVOICE_PDF,
      visibility: FileAssetVisibility.PRIVATE,
      entityType: 'INVOICE',
      entityId: invoiceId,
      allowedMimeTypes: this.pdfMimeTypes,
      maxSizeMb: 15,
      compressImage: false,
    });

    await this.prisma.invoice.update({
      where: {
        id: invoiceId,
      },
      data: {
        pdfUrl: asset.publicUrl || `/files/${asset.id}/download`,
      },
    });

    await this.createEvent({
      interventionId: invoice.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'PDF de facture ajouté',
      message: 'Le PDF de la facture a été ajouté.',
      createdById: user.id,
      metadata: {
        invoiceId,
        fileId: asset.id,
      },
    });

    return asset;
  }

  // ==========================================================
  // Complaint attachment
  // ==========================================================

  async uploadComplaintAttachment(
    user: AuthenticatedUser,
    complaintId: number,
    file: Express.Multer.File,
  ) {
    const complaint = await this.checkComplaintAccess(user, complaintId);

    const asset = await this.createFileAsset(user, file, {
      purpose: FileAssetPurpose.COMPLAINT_ATTACHMENT,
      visibility: FileAssetVisibility.PRIVATE,
      entityType: 'COMPLAINT',
      entityId: complaintId,
      allowedMimeTypes: this.documentMimeTypes,
      maxSizeMb: 15,
      compressImage: true,
    });

    await this.prisma.complaint.update({
      where: {
        id: complaintId,
      },
      data: {
        attachments: {
          push: asset.publicUrl || `/files/${asset.id}/download`,
        },
      },
    });

    await this.createEvent({
      interventionId: complaint.interventionId,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Pièce jointe ajoutée',
      message: 'Une pièce jointe a été ajoutée à la réclamation.',
      createdById: user.id,
      metadata: {
        complaintId,
        fileId: asset.id,
      },
    });

    return asset;
  }

  // ==========================================================
  // File listing / detail
  // ==========================================================

  async findByEntity(
    user: AuthenticatedUser,
    entityType: string,
    entityId: number,
  ) {
    const files = await this.prisma.fileAsset.findMany({
      where: {
        entityType,
        entityId,
        isDeleted: false,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    for (const file of files) {
      await this.checkFileAccess(user, file);
    }

    return files;
  }

  async findOne(user: AuthenticatedUser, fileId: number) {
    const asset = await this.getFileAssetOrFail(fileId);

    await this.checkFileAccess(user, asset);

    return asset;
  }

  async getDownloadInfo(user: AuthenticatedUser, fileId: number) {
    const asset = await this.getFileAssetOrFail(fileId);

    await this.checkFileAccess(user, asset);

    return {
      asset,
      absolutePath: this.absolutePathFromAsset(asset),
    };
  }

  // ==========================================================
  // Delete file
  // ==========================================================

  async deleteFile(user: AuthenticatedUser, fileId: number) {
    const asset = await this.getFileAssetOrFail(fileId);

    await this.checkCanModifyFile(user, asset);

    const absolutePath = this.absolutePathFromAsset(asset);

    try {
      await fs.unlink(absolutePath);
    } catch {
      // File may already be missing on disk.
    }

    return this.prisma.fileAsset.update({
      where: {
        id: fileId,
      },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
      },
    });
  }

  // ==========================================================
  // Replace file
  // ==========================================================

  async replaceFile(
    user: AuthenticatedUser,
    fileId: number,
    file: Express.Multer.File,
  ) {
    const oldAsset = await this.getFileAssetOrFail(fileId);

    await this.checkCanModifyFile(user, oldAsset);

    const allowedMimeTypes = oldAsset.isImage
      ? this.imageMimeTypes
      : oldAsset.mimeType === 'application/pdf'
        ? this.pdfMimeTypes
        : this.documentMimeTypes;

    const newAsset = await this.createFileAsset(user, file, {
      purpose: oldAsset.purpose,
      visibility: oldAsset.visibility,
      entityType: oldAsset.entityType || undefined,
      entityId: oldAsset.entityId || undefined,
      allowedMimeTypes,
      maxSizeMb: oldAsset.mimeType === 'application/pdf' ? 15 : 12,
      compressImage: oldAsset.isImage,
    });

    await this.prisma.fileAsset.update({
      where: {
        id: oldAsset.id,
      },
      data: {
        replacedById: newAsset.id,
        isDeleted: true,
        deletedAt: new Date(),
      },
    });

    try {
      await fs.unlink(this.absolutePathFromAsset(oldAsset));
    } catch {
      // Ignore missing disk file.
    }

    await this.replaceUrlReferences(oldAsset, newAsset);

    return {
      oldFile: oldAsset,
      newFile: newAsset,
    };
  }

  private async replaceUrlReferences(oldAsset: any, newAsset: any) {
    const oldUrl = oldAsset.publicUrl || `/files/${oldAsset.id}/download`;
    const newUrl = newAsset.publicUrl || `/files/${newAsset.id}/download`;

    if (oldAsset.entityType === 'QUOTE' && oldAsset.entityId) {
      await this.prisma.quote.updateMany({
        where: {
          id: oldAsset.entityId,
          pdfUrl: oldUrl,
        },
        data: {
          pdfUrl: newUrl,
        },
      });
    }

    if (oldAsset.entityType === 'INVOICE' && oldAsset.entityId) {
      await this.prisma.invoice.updateMany({
        where: {
          id: oldAsset.entityId,
          pdfUrl: oldUrl,
        },
        data: {
          pdfUrl: newUrl,
        },
      });
    }

    if (oldAsset.entityType === 'INTERVENTION' && oldAsset.entityId) {
      await this.prisma.intervention.updateMany({
        where: {
          id: oldAsset.entityId,
          beforePhotoUrl: oldUrl,
        },
        data: {
          beforePhotoUrl: newUrl,
        },
      });

      await this.prisma.intervention.updateMany({
        where: {
          id: oldAsset.entityId,
          afterPhotoUrl: oldUrl,
        },
        data: {
          afterPhotoUrl: newUrl,
        },
      });
    }
  }

  // ==========================================================
  // Visibility
  // ==========================================================

  async setVisibility(
    user: AuthenticatedUser,
    fileId: number,
    visibility: FileAssetVisibility,
  ) {
    const asset = await this.getFileAssetOrFail(fileId);

    if (!this.isAdminRole(user.role)) {
      throw new ForbiddenException(
        'Seule l’administration peut modifier la visibilité.',
      );
    }

    const oldAbsolutePath = this.absolutePathFromAsset(asset);
    const purposeFolder = this.safeFolderName(asset.purpose);
    const visibilityFolder =
      visibility === FileAssetVisibility.PUBLIC ? 'public' : 'private';

    const newRelativePath = path
      .join(visibilityFolder, purposeFolder, asset.fileName)
      .replace(/\\/g, '/');

    const newAbsolutePath = path.join(this.uploadRoot, newRelativePath);

    await this.ensureDir(path.dirname(newAbsolutePath));

    try {
      await fs.rename(oldAbsolutePath, newAbsolutePath);
    } catch {
      // If file is missing on disk, still update DB metadata.
    }

    const publicUrl =
      visibility === FileAssetVisibility.PUBLIC
        ? `/uploads/${newRelativePath}`
        : null;

    return this.prisma.fileAsset.update({
      where: {
        id: fileId,
      },
      data: {
        visibility,
        relativePath: newRelativePath,
        publicUrl,
      },
    });
  }
}