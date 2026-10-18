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
import { fileForParties } from '../../common/views/views';
import { InterventionEventsService } from '../intervention-events/intervention-events.service';
import { Semaphore } from '../../common/concurrency/limits';

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

/**
 * The purposes of the photos that prove a job (P1-07). Their files are written by ProofsService
 * after its checks and are never changed or deleted afterwards: a proof that could be replaced
 * once it was accepted would not prove anything.
 */
export const PROOF_PURPOSES: FileAssetPurpose[] = [
  FileAssetPurpose.ARTISAN_BEFORE_PHOTO,
  FileAssetPurpose.ARTISAN_AFTER_PHOTO,
];

/** Largest proof photo, in MB (the app compresses before sending; the server compresses again). */
export const PROOF_MAX_MB = 10;

/** The most pixels a proof photo may have once decoded. */
const PROOF_MAX_PIXELS = 100_000_000;

type LocalUploadOptions = {
  purpose: FileAssetPurpose;
  visibility?: FileAssetVisibility;
  entityType?: string;
  entityId?: number;
  allowedMimeTypes: string[];
  maxSizeMb: number;
  compressImage?: boolean;
  /**
   * Most pixels an image may have once decoded. A small file can unpack to an
   * enormous picture and use up the server's memory; the default of the image
   * library is far above any phone photo, so a public upload sets its own.
   */
  maxInputPixels?: number;
};

export type StoredLocalFile = {
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

  /**
   * Decoding a large picture takes a second and a few hundred MB. Pictures from
   * visitors with no account are decoded two at a time, whatever the number of
   * calls, so a handful of links cannot slow the whole server (logins hash on the
   * same worker threads).
   */
  private readonly guestDecodeSlots = new Semaphore(2);

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

  /**
   * A file as this reader may read it. The back office gets the row; everybody else gets what the
   * file is and where to fetch it, not where the server keeps it, nor the uploader's address.
   */
  private forReader(user: AuthenticatedUser, asset: any) {
    return this.isAdminRole(user.role) ? asset : fileForParties(asset);
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

  /**
   * What the first bytes of the file say it is. The type a browser or an app
   * declares is only a claim: an upload that says "image/jpeg" and carries
   * something else must not reach the image decoder.
   */
  private hasImageSignature(buffer: Buffer): boolean {
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng =
      buffer.length > 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp =
      buffer.length > 12 &&
      buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP';

    return isJpeg || isPng || isWebp;
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

    if (this.isImage(file.mimetype) && !this.hasImageSignature(file.buffer)) {
      throw new BadRequestException("Le fichier n'est pas une image valide (JPEG, PNG ou WebP).");
    }
  }

  private async processImageIfNeeded(
    file: Express.Multer.File,
    compressImage: boolean,
    maxInputPixels?: number,
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

    const input = maxInputPixels ? { limitInputPixels: maxInputPixels } : {};

    try {
      const metadata = await sharp(file.buffer, input).metadata();

      if (!compressImage) {
        return {
          buffer: file.buffer,
          mimeType: file.mimetype,
          width: metadata.width,
          height: metadata.height,
        };
      }

      const compressed = await sharp(file.buffer, input)
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
    } catch {
      // A damaged picture, or one with more pixels than allowed: a refusal, not a server error.
      throw new BadRequestException('Image illisible, corrompue ou trop grande.');
    }
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
      options.maxInputPixels,
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

  private assetData(
    user: AuthenticatedUser,
    file: Express.Multer.File,
    options: LocalUploadOptions,
    stored: StoredLocalFile,
  ) {
    return {
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
    };
  }

  private async createFileAsset(
    user: AuthenticatedUser,
    file: Express.Multer.File,
    options: LocalUploadOptions,
  ) {
    const stored = await this.storeLocalFile(file, options);

    return this.prisma.fileAsset.create({
      data: this.assetData(user, file, options, stored),
    });
  }

  // ==========================================================
  // Proof photos (P1-07): written in two steps so the caller can put the database row in
  // its own transaction. The folder is private; the photo is read through the download route.
  // ==========================================================

  private proofOptions(purpose: FileAssetPurpose, interventionId: number): LocalUploadOptions {
    return {
      purpose,
      visibility: FileAssetVisibility.PRIVATE,
      entityType: 'INTERVENTION',
      entityId: interventionId,
      allowedMimeTypes: this.imageMimeTypes,
      maxSizeMb: PROOF_MAX_MB,
      compressImage: true,
      maxInputPixels: PROOF_MAX_PIXELS,
    };
  }

  /**
   * Refuses what is not a JPEG, PNG or WebP photo before any of it is decoded or kept. HEIC is
   * named: the phones that produce it can switch to JPEG, and "unsupported" alone leaves the
   * artisan with no way to go on.
   */
  assertProofImage(file: Express.Multer.File | undefined | null) {
    if (!file) {
      throw new BadRequestException('La photo est obligatoire.');
    }

    if (/^image\/(heic|heif)$/i.test(file.mimetype ?? '') || file.buffer?.subarray(4, 8).toString('latin1') === 'ftyp') {
      throw new BadRequestException('Le format HEIC n’est pas pris en charge. Prenez la photo en JPEG.');
    }

    this.validateFile(file, this.imageMimeTypes, PROOF_MAX_MB);
  }

  /** Compresses the photo and writes it to the private folder. No database row yet. */
  stageProofPhoto(file: Express.Multer.File, purpose: FileAssetPurpose, interventionId: number) {
    return this.storeLocalFile(file, this.proofOptions(purpose, interventionId));
  }

  /** The row of a staged photo, written with the `db` (a transaction) of the caller. */
  recordProofAsset(
    db: { fileAsset: { create: (args: { data: any }) => Promise<any> } },
    user: AuthenticatedUser,
    file: Express.Multer.File,
    stored: StoredLocalFile,
    purpose: FileAssetPurpose,
    interventionId: number,
  ) {
    return db.fileAsset.create({
      data: this.assetData(user, file, this.proofOptions(purpose, interventionId), stored),
    });
  }

  /** Takes a staged photo away again (the transaction that should have recorded it failed). */
  async discardStagedPhoto(stored: { relativePath: string }) {
    await fs.unlink(this.absolutePathFromAsset(stored)).catch(() => undefined);
  }

  /** The proof files cannot be changed by the people who may change the other files. */
  private refuseToTouchProof(asset: { purpose: FileAssetPurpose }) {
    if (PROOF_PURPOSES.includes(asset.purpose)) {
      throw new ForbiddenException(
        'Une photo de preuve ne peut ni être remplacée ni être supprimée. Ajoutez une nouvelle preuve si besoin.',
      );
    }
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

    return this.forReader(user, asset);
  }

  // ==========================================================
  // Photo from the holder of a tracking link (request made without an account)
  // ==========================================================

  /**
   * The caller (GuestService) has already checked the tracking link, the status
   * of the request and how many photos it holds; this stores one picture.
   * The picture is re-encoded (which drops its metadata, GPS position included)
   * and kept private: staff read it through /files/:id/download.
   */
  async uploadGuestDamagePhoto(
    intervention: { id: number; clientId: number },
    file: Express.Multer.File,
  ) {
    const asset = await this.guestDecodeSlots.run(() =>
      this.createFileAsset({ id: intervention.clientId, role: Role.CLIENT }, file, {
        purpose: FileAssetPurpose.CLIENT_DAMAGE_PHOTO,
        visibility: FileAssetVisibility.PRIVATE,
        entityType: 'INTERVENTION',
        entityId: intervention.id,
        allowedMimeTypes: this.imageMimeTypes,
        maxSizeMb: 5,
        compressImage: true,
        // 30 million pixels: a 24 megapixel camera is fine, a 50 megapixel decode is not worth the memory.
        maxInputPixels: 30_000_000,
      }),
    );

    await this.prisma.intervention.update({
      where: {
        id: intervention.id,
      },
      data: {
        photos: {
          push: asset.publicUrl || `/files/${asset.id}/download`,
        },
      },
    });

    await this.createEvent({
      interventionId: intervention.id,
      type: InterventionEventType.STATUS_CHANGED,
      title: 'Photo client ajoutée',
      message: 'Une photo du problème a été ajoutée.',
      createdById: intervention.clientId,
      metadata: {
        fileId: asset.id,
        purpose: asset.purpose,
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
      asset: this.forReader(user, asset),
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

    return this.forReader(user, asset);
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

    return this.forReader(user, asset);
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

    return this.forReader(user, asset);
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

    return files.map((file) => this.forReader(user, file));
  }

  async findOne(user: AuthenticatedUser, fileId: number) {
    const asset = await this.getFileAssetOrFail(fileId);

    await this.checkFileAccess(user, asset);

    return this.forReader(user, asset);
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
    this.refuseToTouchProof(asset);

    const absolutePath = this.absolutePathFromAsset(asset);

    try {
      await fs.unlink(absolutePath);
    } catch {
      // File may already be missing on disk.
    }

    const deleted = await this.prisma.fileAsset.update({
      where: {
        id: fileId,
      },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
      },
    });

    return this.forReader(user, deleted);
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
    this.refuseToTouchProof(oldAsset);

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
      oldFile: this.forReader(user, oldAsset),
      newFile: this.forReader(user, newAsset),
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

    // The photos of an intervention that prove the work are not replaced (see refuseToTouchProof),
    // so no column of the intervention follows a replacement.
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

    // A proof stays behind the login, whoever asks.
    if (PROOF_PURPOSES.includes(asset.purpose) && visibility !== FileAssetVisibility.PRIVATE) {
      throw new ForbiddenException('Une photo de preuve reste privée.');
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
