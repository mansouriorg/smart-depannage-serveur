import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';

import { FilesService } from './files.service';

import {
  SetFileVisibilityDto,
  UploadArtisanDocumentDto,
} from './dto/file.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

import {
  ArtisanDocumentType,
  Role,
} from '../../../generated/prisma/client';

import type {
  FileAssetVisibility,
} from '../../../generated/prisma/client';

type AuthenticatedUser = {
  id: number;
  role: Role;
};

type PrivateFileVisibility = 'PRIVATE';

@Controller('files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  private normalizePrivateVisibility(
    visibility?: FileAssetVisibility,
  ): PrivateFileVisibility | undefined {
    if (visibility === 'PRIVATE') {
      return 'PRIVATE';
    }

    return undefined;
  }

  // ==========================================================
  // Client damage photos
  // ==========================================================

  /**
   * Upload client damage photo.
   *
   * POST /files/interventions/:interventionId/damage-photo
   *
   * FormData:
   * file: image
   */
  @RequirePermission(Permission.FILES_DAMAGE_PHOTO)
  @Post('interventions/:interventionId/damage-photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 8 * 1024 * 1024,
      },
    }),
  )
  uploadClientDamagePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadClientDamagePhoto(
      user,
      interventionId,
      file,
    );
  }

  // ==========================================================
  // Artisan before / after photos: POST /interventions/:id/proofs/:kind (ProofsController).
  // The photo is checked there (position, time, accuracy, reuse) before it is kept.
  // ==========================================================

  // ==========================================================
  // Artisan documents
  // ==========================================================

  /**
   * Upload artisan document.
   *
   * POST /files/artisan/documents
   *
   * FormData:
   * file: pdf/image
   * type: IDENTITY / INSURANCE / COMPANY_LEGAL / CERTIFICATE / PROFILE_PHOTO / OTHER
   * visibility: PRIVATE
   *
   * Note:
   * The service currently only accepts PRIVATE for artisan documents.
   * PUBLIC visibility can still be handled later via:
   * PATCH /files/:fileId/visibility
   */
  @RequirePermission(Permission.FILES_ARTISAN_DOCS)
  @Post('artisan/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 12 * 1024 * 1024,
      },
    }),
  )
  uploadArtisanDocument(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadArtisanDocumentDto,
  ) {
    return this.filesService.uploadArtisanDocument(
      user,
      file,
      dto.type,
      this.normalizePrivateVisibility(dto.visibility),
    );
  }

  /**
   * Upload identity document shortcut.
   *
   * POST /files/artisan/identity
   *
   * FormData:
   * file: pdf/image
   */
  @RequirePermission(Permission.FILES_ARTISAN_DOCS)
  @Post('artisan/identity')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 12 * 1024 * 1024,
      },
    }),
  )
  uploadIdentityDocument(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadArtisanDocument(
      user,
      file,
      ArtisanDocumentType.IDENTITY,
      'PRIVATE',
    );
  }

  /**
   * Upload insurance certificate shortcut.
   *
   * POST /files/artisan/insurance
   *
   * FormData:
   * file: pdf/image
   */
  @RequirePermission(Permission.FILES_ARTISAN_DOCS)
  @Post('artisan/insurance')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 12 * 1024 * 1024,
      },
    }),
  )
  uploadInsuranceCertificate(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadArtisanDocument(
      user,
      file,
      ArtisanDocumentType.INSURANCE,
      'PRIVATE',
    );
  }

  // ==========================================================
  // Quote PDF
  // ==========================================================

  /**
   * Upload quote PDF.
   *
   * POST /files/quotes/:quoteId/pdf
   *
   * FormData:
   * file: pdf
   */
  @RequirePermission(Permission.FILES_QUOTE_PDF)
  @Post('quotes/:quoteId/pdf')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 15 * 1024 * 1024,
      },
    }),
  )
  uploadQuotePdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadQuotePdf(user, quoteId, file);
  }

  // ==========================================================
  // Invoice PDF
  // ==========================================================

  /**
   * Upload invoice PDF.
   *
   * POST /files/invoices/:invoiceId/pdf
   *
   * FormData:
   * file: pdf
   */
  @RequirePermission(Permission.FILES_INVOICE_PDF)
  @Post('invoices/:invoiceId/pdf')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 15 * 1024 * 1024,
      },
    }),
  )
  uploadInvoicePdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadInvoicePdf(user, invoiceId, file);
  }

  // ==========================================================
  // Complaint attachment
  // ==========================================================

  /**
   * Upload complaint attachment.
   *
   * POST /files/complaints/:complaintId/attachment
   *
   * FormData:
   * file: pdf/image
   */
  @RequirePermission(Permission.FILES_COMPLAINT_ATTACHMENT)
  @Post('complaints/:complaintId/attachment')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 15 * 1024 * 1024,
      },
    }),
  )
  uploadComplaintAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('complaintId', ParseIntPipe) complaintId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadComplaintAttachment(
      user,
      complaintId,
      file,
    );
  }

  // ==========================================================
  // List files by entity
  // Must stay before GET /files/:fileId
  // ==========================================================

  /**
   * List files for an entity.
   *
   * GET /files/entity/INTERVENTION/12
   * GET /files/entity/QUOTE/5
   * GET /files/entity/INVOICE/7
   * GET /files/entity/COMPLAINT/3
   * GET /files/entity/ARTISAN_PROFILE/2
   */
  @RequirePermission(Permission.FILES_USE)
  @Get('entity/:entityType/:entityId')
  findByEntity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
  ) {
    return this.filesService.findByEntity(user, entityType, entityId);
  }

  // ==========================================================
  // Download file
  // Must stay before GET /files/:fileId
  // ==========================================================

  /**
   * Download private/public file with access check.
   *
   * GET /files/:fileId/download
   */
  @RequirePermission(Permission.FILES_USE)
  @Get(':fileId/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Res() res: Response,
  ) {
    const { asset, absolutePath } =
      await this.filesService.getDownloadInfo(user, fileId);

    res.setHeader('Content-Type', asset.mimeType);
    // Shown inline from the API's own origin: the browser must use the declared type, never guess one.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(asset.originalName)}"`,
    );

    return res.sendFile(absolutePath);
  }

  // ==========================================================
  // File metadata
  // ==========================================================

  /**
   * File metadata.
   *
   * GET /files/:fileId
   */
  @RequirePermission(Permission.FILES_USE)
  @Get(':fileId')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId', ParseIntPipe) fileId: number,
  ) {
    return this.filesService.findOne(user, fileId);
  }

  // ==========================================================
  // Replace file
  // ==========================================================

  /**
   * Replace an existing file.
   *
   * PATCH /files/:fileId/replace
   *
   * FormData:
   * file: new file
   */
  @RequirePermission(Permission.FILES_USE)
  @Patch(':fileId/replace')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 15 * 1024 * 1024,
      },
    }),
  )
  replaceFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId', ParseIntPipe) fileId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.replaceFile(user, fileId, file);
  }

  // ==========================================================
  // File visibility
  // ==========================================================

  /**
   * Set file visibility.
   *
   * PATCH /files/:fileId/visibility
   *
   * Body:
   * {
   *   "visibility": "PUBLIC"
   * }
   */
  @RequirePermission(Permission.FILES_VISIBILITY)
  @Patch(':fileId/visibility')
  setVisibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: SetFileVisibilityDto,
  ) {
    return this.filesService.setVisibility(
      user,
      fileId,
      dto.visibility,
    );
  }

  // ==========================================================
  // Delete file
  // ==========================================================

  /**
   * Delete file.
   *
   * DELETE /files/:fileId
   */
  @RequirePermission(Permission.FILES_USE)
  @Delete(':fileId')
  deleteFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId', ParseIntPipe) fileId: number,
  ) {
    return this.filesService.deleteFile(user, fileId);
  }
}
