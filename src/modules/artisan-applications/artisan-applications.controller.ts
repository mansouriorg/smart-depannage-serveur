import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request, ForbiddenException } from '@nestjs/common';
import { ArtisanApplicationsService } from './artisan-applications.service';
import { CreateArtisanApplicationDto } from './dto/create-artisan-application.dto';
import { AuthGuard } from '@nestjs/passport';

@Controller('artisan-applications')
export class ArtisanApplicationsController {
  constructor(private readonly service: ArtisanApplicationsService) {}

  // 🟢 PUBLIC: Join Us Form
  @Post()
  create(@Body() dto: CreateArtisanApplicationDto) {
    return this.service.create(dto);
  }

  // 🔒 ADMIN ONLY: List Applications
  @Get()
  @UseGuards(AuthGuard('jwt'))
  findAll(@Request() req) {
    if (req.user.role !== 'ADMIN') throw new ForbiddenException('Accès réservé aux admins.');
    return this.service.findAll();
  }

  // 🔒 ADMIN ONLY: Approve
  @Patch(':id/approve')
  @UseGuards(AuthGuard('jwt'))
  approve(@Request() req, @Param('id') id: string) {
    if (req.user.role !== 'ADMIN') throw new ForbiddenException('Accès réservé aux admins.');
    return this.service.approve(+id);
  }

  // 🔒 ADMIN ONLY: Reject
  @Patch(':id/reject')
  @UseGuards(AuthGuard('jwt'))
  reject(@Request() req, @Param('id') id: string) {
    if (req.user.role !== 'ADMIN') throw new ForbiddenException('Accès réservé aux admins.');
    return this.service.reject(+id);
  }
}