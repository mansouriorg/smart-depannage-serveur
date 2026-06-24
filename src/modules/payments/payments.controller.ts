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
import { PaymentsService } from './payments.service';
import { CreateManualPaymentDto } from './dto/create-manual-payment.dto';
import { AdminPaymentActionDto } from './dto/admin-payment-action.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Post('interventions/:interventionId')
  createClientPaymentRequest(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
    @Body() dto: CreateManualPaymentDto,
  ) {
    return this.service.createClientPaymentRequest(
      userId,
      interventionId,
      dto,
    );
  }

  @Roles(Role.CLIENT, Role.ADMIN, Role.SUPER_ADMIN)
  @Get('interventions/:interventionId')
  findForClient(
    @CurrentUser('id') userId: number,
    @Param('interventionId', ParseIntPipe) interventionId: number,
  ) {
    return this.service.findForClient(userId, interventionId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Patch(':paymentId/confirm')
  confirm(
    @CurrentUser('id') adminId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: AdminPaymentActionDto,
  ) {
    return this.service.confirm(paymentId, adminId, dto);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Patch(':paymentId/fail')
  fail(
    @CurrentUser('id') adminId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: AdminPaymentActionDto,
  ) {
    return this.service.fail(paymentId, adminId, dto);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.ACCOUNTANT)
  @Patch(':paymentId/refund')
  refund(
    @CurrentUser('id') adminId: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: AdminPaymentActionDto,
  ) {
    return this.service.refund(paymentId, adminId, dto);
  }
}