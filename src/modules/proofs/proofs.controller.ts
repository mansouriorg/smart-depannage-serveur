import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';

import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { AddProofDto, ListProofsDto, ReviewProofDto } from './dto/proofs.dto';
import { PROOF_UPLOAD } from './proof-upload';
import { ProofsService } from './proofs.service';

@Controller()
export class ProofsController {
  constructor(private readonly proofs: ProofsService) {}

  /**
   * POST /interventions/:id/proofs/before | after
   *
   * multipart: photo, latitude, longitude, accuracy (metres), mocked (true/false), capturedAt.
   * The role is checked BEFORE the photo is read. An artisan must be the artisan of the job and
   * on site; the back office may add a photo without a position.
   */
  @RequirePermission(Permission.PROOFS_ADD)
  @Post('interventions/:id/proofs/:kind')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  @UseInterceptors(FileInterceptor('photo', PROOF_UPLOAD))
  async add(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Param('kind') kind: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: AddProofDto,
  ) {
    const wanted = String(kind).toLowerCase();

    if (wanted !== 'before' && wanted !== 'after') {
      throw new NotFoundException('Type de preuve inconnu: utilisez « before » ou « after ».');
    }

    const result = await this.proofs.submit({
      interventionId: id,
      kind: wanted === 'before' ? 'BEFORE' : 'AFTER',
      actor: { id: req.user.id, role: req.user.role },
      file,
      capture: { ...body, capturedAt: body?.capturedAt ?? body?.timestamp },
    });

    return result.view;
  }

  /** GET /proofs?status=NEEDS_REVIEW&interventionId=12 — the back office. */
  @RequirePermission(Permission.PROOFS_REVIEW)
  @Get('proofs')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  list(@Query() query: ListProofsDto) {
    return this.proofs.list(query);
  }

  /** PATCH /proofs/:id/review { decision: APPROVE | REJECT, note? } — the back office. */
  @RequirePermission(Permission.PROOFS_REVIEW)
  @Patch('proofs/:id/review')
  @UseGuards(AuthGuard('jwt'), PermissionsGuard)
  review(@Request() req, @Param('id', ParseIntPipe) id: number, @Body() dto: ReviewProofDto) {
    return this.proofs.review({
      proofId: id,
      decision: dto.decision,
      note: dto.note,
      reviewer: { id: req.user.id, role: req.user.role },
    });
  }
}
