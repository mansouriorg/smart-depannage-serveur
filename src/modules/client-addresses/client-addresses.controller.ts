import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ClientAddressesService } from './client-addresses.service';
import { CreateClientAddressDto } from './dto/create-client-address.dto';
import { UpdateClientAddressDto } from './dto/update-client-address.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
@Controller('client/addresses')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ClientAddressesController {
  constructor(private readonly service: ClientAddressesService) {}

  @RequirePermission(Permission.CLIENT_ADDRESSES)
  @Post()
  create(
    @CurrentUser('id') userId: number,
    @Body() dto: CreateClientAddressDto,
  ) {
    return this.service.create(userId, dto);
  }

  @RequirePermission(Permission.CLIENT_ADDRESSES)
  @Get()
  findMine(@CurrentUser('id') userId: number) {
    return this.service.findMine(userId);
  }

  @RequirePermission(Permission.CLIENT_ADDRESSES)
  @Get(':id')
  findOne(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.findOneForClient(userId, id);
  }

  @RequirePermission(Permission.CLIENT_ADDRESSES)
  @Patch(':id')
  update(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClientAddressDto,
  ) {
    return this.service.update(userId, id, dto);
  }

  @RequirePermission(Permission.CLIENT_ADDRESSES)
  @Delete(':id')
  remove(
    @CurrentUser('id') userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.remove(userId, id);
  }
}
