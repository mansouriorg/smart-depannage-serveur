import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller('invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Post('interventions/:interventionId')
  createForIntervention(
    @CurrentUser('id') adminId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.service.createForIntervention(interventionId, adminId, dto);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('mine')
  findMine(@CurrentUser('id') userId: number) {
    return this.service.findMine(userId);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get(':invoiceId')
  findOne(
    @CurrentUser('id') userId: number,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
  ) {
    return this.service.findOneForClient(userId, invoiceId);
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get(':invoiceId/download')
  download(
    @CurrentUser('id') userId: number,
    @Param('invoiceId', ParseIntPipe) invoiceId: number,
  ) {
    return this.service.downloadForClient(userId, invoiceId);
  }
}