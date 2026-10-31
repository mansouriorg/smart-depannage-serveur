import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ServiceCatalogService } from './service-catalog.service';
import { CreateServiceCategoryDto } from './dto/create-service-category.dto';
import { CreateSubServiceDto } from './dto/create-sub-service.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/auth/permissions';

import {
  Role,
  ServiceType,
} from '../../../generated/prisma/client';

@Controller('services')
export class ServiceCatalogController {
  constructor(private readonly service: ServiceCatalogService) {}

  // ==========================================================
  // 1. PUBLIC ROUTES
  // Used by client app / guest app / mobile app
  // ==========================================================

  @Get()
  publicCatalog() {
    return this.service.findPublicCatalog();
  }

  @Get('type/:serviceType')
  publicCategoryByType(
    @Param('serviceType', new ParseEnumPipe(ServiceType))
    serviceType: ServiceType,
  ) {
    return this.service.findPublicCategoryByType(serviceType);
  }

  @Get('sub-services/:id')
  publicSubService(@Param('id', ParseIntPipe) id: number) {
    return this.service.findPublicSubService(id);
  }

  // ==========================================================
  // 2. OLD COMPATIBILITY ADMIN ROUTE
  // Keeps your previous frontend route working:
  // GET /services/admin
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_READ_ADMIN)
  @Get('admin')
  adminCatalog() {
    return this.service.findAllCategoriesAdmin({
      includeInactive: true,
    });
  }

  // ==========================================================
  // 3. ADMIN CATEGORIES
  // New professional admin routes
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_READ_ADMIN)
  @Get('admin/categories')
  findAllCategoriesAdmin(
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
    @Query('search') search?: string,
  ) {
    return this.service.findAllCategoriesAdmin({
      includeInactive,
      search,
    });
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_READ_ADMIN)
  @Get('admin/categories/:id')
  findCategoryAdmin(@Param('id', ParseIntPipe) id: number) {
    return this.service.findCategoryAdmin(id);
  }

  // Old compatible route:
  // POST /services/categories
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Post('categories')
  createCategoryOldRoute(@Body() dto: CreateServiceCategoryDto) {
    return this.service.createCategory(dto);
  }

  // New route:
  // POST /services/admin/categories
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Post('admin/categories')
  createCategory(@Body() dto: CreateServiceCategoryDto) {
    return this.service.createCategory(dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Patch('admin/categories/:id')
  updateCategory(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateServiceCategoryDto>,
  ) {
    return this.service.updateCategory(id, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Patch('admin/categories/:id/activate')
  activateCategory(@Param('id', ParseIntPipe) id: number) {
    return this.service.activateCategory(id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Patch('admin/categories/:id/deactivate')
  deactivateCategory(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateCategory(id);
  }

  // ==========================================================
  // 4. ADMIN SUB-SERVICES
  // ==========================================================

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_READ_ADMIN)
  @Get('admin/sub-services')
  findAllSubServicesAdmin(
    @Query('categoryId') categoryId?: string,
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
    @Query('search') search?: string,
  ) {
    return this.service.findAllSubServicesAdmin({
      categoryId: categoryId ? Number(categoryId) : undefined,
      includeInactive,
      search,
    });
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_READ_ADMIN)
  @Get('admin/sub-services/:id')
  findSubServiceAdmin(@Param('id', ParseIntPipe) id: number) {
    return this.service.findSubServiceAdmin(id);
  }

  // Old compatible route:
  // POST /services/sub-services
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Post('sub-services')
  createSubServiceOldRoute(@Body() dto: CreateSubServiceDto) {
    return this.service.createSubService(dto);
  }

  // New route:
  // POST /services/admin/sub-services
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Post('admin/sub-services')
  createSubService(@Body() dto: CreateSubServiceDto) {
    return this.service.createSubService(dto);
  }

  // Old compatible route:
  // PATCH /services/sub-services/:id
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Patch('sub-services/:id')
  updateSubServiceOldRoute(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateSubServiceDto>,
  ) {
    return this.service.updateSubService(id, dto);
  }

  // New route:
  // PATCH /services/admin/sub-services/:id
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Patch('admin/sub-services/:id')
  updateSubService(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateSubServiceDto>,
  ) {
    return this.service.updateSubService(id, dto);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Patch('admin/sub-services/:id/activate')
  activateSubService(@Param('id', ParseIntPipe) id: number) {
    return this.service.activateSubService(id);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Patch('admin/sub-services/:id/deactivate')
  deactivateSubService(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivateSubService(id);
  }

  // Old compatible route:
  // DELETE /services/sub-services/:id
  // This only deactivates the sub-service.
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Delete('sub-services/:id')
  removeSubServiceOldRoute(@Param('id', ParseIntPipe) id: number) {
    return this.service.removeSubService(id);
  }

  // New route:
  // DELETE /services/admin/sub-services/:id
  // This deletes only if unused, otherwise deactivates.
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(Permission.CATALOG_MANAGE)
  @Delete('admin/sub-services/:id')
  deleteSubService(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteSubService(id);
  }
}
