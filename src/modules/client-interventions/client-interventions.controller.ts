import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ClientInterventionsService } from './client-interventions.service';
import { CreateClientInterventionDto } from './dto/create-client-intervention.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  RateLimit,
  RateLimitGuard,
} from '../../common/rate-limit/rate-limit.guard';

@Controller()
export class ClientInterventionsController {
  constructor(private readonly service: ClientInterventionsService) {}

  // Every request alerts the whole back office (P1-04): not unlimited.
  @UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
  @RateLimit({ name: 'client-create', limit: 60, windowMs: 60 * 60_000 })
  @RequirePermission(Permission.CLIENT_REQUESTS)
  @Post('client/interventions')
  create(
    @CurrentUser('id') userId: number,
    @Body() dto: CreateClientInterventionDto,
  ) {
    return this.service.create(userId, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CLIENT_REQUESTS)
  @Get('client/interventions')
  findMine(@CurrentUser('id') userId: number) {
    return this.service.findMine(userId);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CLIENT_REQUESTS)
  @Get('client/interventions/:id')
  findOneMine(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.findOneMine(userId, id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CLIENT_REQUESTS)
  @Get('client/interventions/:id/tracking')
  tracking(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.tracking(userId, id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CLIENT_REQUESTS)
  @Patch('client/interventions/:id/cancel')
  cancel(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.cancel(userId, id);
  }
}
