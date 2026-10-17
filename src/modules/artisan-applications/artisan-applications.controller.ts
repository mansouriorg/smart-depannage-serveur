import { Controller, Get, Post, Body, Patch, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ArtisanApplicationsService } from './artisan-applications.service';
import { CreateArtisanApplicationDto } from './dto/create-artisan-application.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller('artisan-applications')
export class ArtisanApplicationsController {
  constructor(private readonly service: ArtisanApplicationsService) {}

  // 🟢 PUBLIC: Join Us Form
  @Post()
  create(@Body() dto: CreateArtisanApplicationDto) {
    return this.service.create(dto);
  }

  // 🔒 STAFF ONLY: List Applications
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  findAll() {
    return this.service.findAll();
  }

  // 🔒 STAFF ONLY: Approve
  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  approve(@Param('id', ParseIntPipe) id: number) {
    return this.service.approve(id);
  }

  // 🔒 STAFF ONLY: Reject
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  reject(@Param('id', ParseIntPipe) id: number) {
    return this.service.reject(id);
  }
}
