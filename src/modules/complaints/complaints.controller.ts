import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ComplaintsService } from './complaints.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { UpdateComplaintStatusDto } from './dto/update-complaint-status.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller('complaints')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ComplaintsController {
  constructor(private readonly service: ComplaintsService) {}

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Post('interventions/:interventionId')
  create(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateComplaintDto,
  ) {
    return this.service.create(userId, interventionId, dto);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('mine')
  findMine(@CurrentUser('id') userId: number) {
    return this.service.findMine(userId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  @Get()
  findAllAdmin(@Query('status') status?: string) {
    return this.service.findAllAdmin(status);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.SUPPORT)
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateComplaintStatusDto,
  ) {
    return this.service.updateStatus(id, dto);
  }
}