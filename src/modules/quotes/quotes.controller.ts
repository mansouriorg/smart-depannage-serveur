import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { ClientQuoteActionDto } from './dto/client-quote-action.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller('quotes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuotesController {
  constructor(private readonly service: QuotesService) {}

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.DISPATCHER)
  @Post('interventions/:interventionId')
  createForIntervention(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateQuoteDto,
  ) {
    return this.service.createForIntervention(interventionId, userId, dto);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('interventions/:interventionId')
  findForClient(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findForClient(userId, interventionId);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Post(':quoteId/accept')
  accept(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.service.accept(userId, quoteId, dto);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Post(':quoteId/reject')
  reject(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.service.reject(userId, quoteId, dto);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Post(':quoteId/request-modification')
  requestModification(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
    @Body() dto: ClientQuoteActionDto,
  ) {
    return this.service.requestModification(userId, quoteId, dto);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get(':quoteId/download')
  download(
    @CurrentUser('id') userId: number,
    @Param('quoteId', ParseIntPipe) quoteId: number,
  ) {
    return this.service.downloadForClient(userId, quoteId);
  }
}