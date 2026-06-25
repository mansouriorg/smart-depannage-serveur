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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
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
@UseGuards(JwtAuthGuard, RolesGuard)
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
  @Roles(
    Role.CLIENT,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
  )
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
  // Artisan before photo
  // ==========================================================

  /**
   * Upload artisan before photo.
   *
   * POST /files/interventions/:interventionId/before-photo
   *
   * FormData:
   * file: image
   */
  @Roles(
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
  )
  @Post('interventions/:interventionId/before-photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 8 * 1024 * 1024,
      },
    }),
  )
  uploadArtisanBeforePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadArtisanBeforePhoto(
      user,
      interventionId,
      file,
    );
  }

  // ==========================================================
  // Artisan after photo
  // ==========================================================

  /**
   * Upload artisan after photo.
   *
   * POST /files/interventions/:interventionId/after-photo
   *
   * FormData:
   * file: image
   */
  @Roles(
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
  )
  @Post('interventions/:interventionId/after-photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 8 * 1024 * 1024,
      },
    }),
  )
  uploadArtisanAfterPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.filesService.uploadArtisanAfterPhoto(
      user,
      interventionId,
      file,
    );
  }

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
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
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
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
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
  @Roles(Role.ARTISAN, Role.ADMIN, Role.SUPER_ADMIN)
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
  @Roles(
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
  )
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
  @Roles(
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
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
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
  )
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
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
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
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Get(':fileId/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Res() res: Response,
  ) {
    const { asset, absolutePath } =
      await this.filesService.getDownloadInfo(user, fileId);

    res.setHeader('Content-Type', asset.mimeType);
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
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
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
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
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
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
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
  @Roles(
    Role.CLIENT,
    Role.ARTISAN,
    Role.ADMIN,
    Role.SUPER_ADMIN,
    Role.SUPPORT,
    Role.DISPATCHER,
    Role.ACCOUNTANT,
  )
  @Delete(':fileId')
  deleteFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId', ParseIntPipe) fileId: number,
  ) {
    return this.filesService.deleteFile(user, fileId);
  }
}