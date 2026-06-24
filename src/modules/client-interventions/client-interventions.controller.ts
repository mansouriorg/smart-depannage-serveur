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
import { ClientInterventionsService } from './client-interventions.service';
import { CreateClientInterventionDto } from './dto/create-client-intervention.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller()
export class ClientInterventionsController {
  constructor(private readonly service: ClientInterventionsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Post('client/interventions')
  create(
    @CurrentUser('id') userId: number,
    @Body() dto: CreateClientInterventionDto,
  ) {
    return this.service.create(userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('client/interventions')
  findMine(@CurrentUser('id') userId: number) {
    return this.service.findMine(userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('client/interventions/:id')
  findOneMine(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.findOneMine(userId, id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('client/interventions/:id/tracking')
  tracking(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.tracking(userId, id);
  }

  @Get('public/tracking/:id')
  publicTracking(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string,
  ) {
    return this.service.publicTracking(id, token);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('client/interventions/:id/cancel')
  cancel(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.cancel(userId, id);
  }
}