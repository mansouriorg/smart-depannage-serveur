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
import { ServiceCatalogService } from './service-catalog.service';
import { CreateServiceCategoryDto } from './dto/create-service-category.dto';
import { CreateSubServiceDto } from './dto/create-sub-service.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../../generated/prisma/client';

@Controller('services')
export class ServiceCatalogController {
  constructor(private readonly service: ServiceCatalogService) {}

  @Get()
  publicCatalog() {
    return this.service.findCategories();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN, Role.DISPATCHER)
  @Get('admin')
  adminCatalog() {
    return this.service.findAllCategoriesAdmin();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Post('categories')
  createCategory(@Body() dto: CreateServiceCategoryDto) {
    return this.service.createCategory(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Post('sub-services')
  createSubService(@Body() dto: CreateSubServiceDto) {
    return this.service.createSubService(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Patch('sub-services/:id')
  updateSubService(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateSubServiceDto>,
  ) {
    return this.service.updateSubService(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Delete('sub-services/:id')
  removeSubService(@Param('id', ParseIntPipe) id: number) {
    return this.service.removeSubService(id);
  }
}