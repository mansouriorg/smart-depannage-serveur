import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateServiceCategoryDto } from './dto/create-service-category.dto';
import { CreateSubServiceDto } from './dto/create-sub-service.dto';

@Injectable()
export class ServiceCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async createCategory(dto: CreateServiceCategoryDto) {
    return this.prisma.serviceCategory.upsert({
      where: { serviceType: dto.serviceType },
      update: dto,
      create: dto,
    });
  }

  async findCategories() {
    return this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      include: {
        subServices: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findAllCategoriesAdmin() {
    return this.prisma.serviceCategory.findMany({
      include: { subServices: true },
      orderBy: { name: 'asc' },
    });
  }

  async createSubService(dto: CreateSubServiceDto) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id: dto.categoryId },
    });

    if (!category) {
      throw new NotFoundException('Catégorie introuvable.');
    }

    return this.prisma.subService.create({
      data: dto,
    });
  }

  async updateSubService(id: number, dto: Partial<CreateSubServiceDto>) {
    return this.prisma.subService.update({
      where: { id },
      data: dto,
    });
  }

  async removeSubService(id: number) {
    return this.prisma.subService.update({
      where: { id },
      data: { isActive: false },
    });
  }
}