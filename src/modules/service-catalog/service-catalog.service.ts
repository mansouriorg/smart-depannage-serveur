import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

import { CreateServiceCategoryDto } from './dto/create-service-category.dto';
import { CreateSubServiceDto } from './dto/create-sub-service.dto';

import {
  Prisma,
  ServiceType,
} from '../../../generated/prisma/client';

@Injectable()
export class ServiceCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================
  // 1. PUBLIC CATALOG
  // Used by client app / guest app / artisan app
  // ==========================================================

  async findCategories() {
    return this.findPublicCatalog();
  }

  async findPublicCatalog() {
    return this.prisma.serviceCategory.findMany({
      where: {
        isActive: true,
      },
      include: {
        subServices: {
          where: {
            isActive: true,
          },
          orderBy: {
            name: 'asc',
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findPublicCategoryByType(serviceType: ServiceType) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: {
        serviceType,
      },
      include: {
        subServices: {
          where: {
            isActive: true,
          },
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    if (!category || !category.isActive) {
      throw new NotFoundException('Catégorie de service introuvable.');
    }

    return category;
  }

  async findPublicSubService(id: number) {
    const subService = await this.prisma.subService.findUnique({
      where: {
        id,
      },
      include: {
        category: true,
      },
    });

    if (!subService || !subService.isActive || !subService.category.isActive) {
      throw new NotFoundException('Sous-service introuvable.');
    }

    return subService;
  }

  // ==========================================================
  // 2. ADMIN CATEGORIES
  // ==========================================================

  async createCategory(dto: CreateServiceCategoryDto) {
    const existingCategory = await this.prisma.serviceCategory.findUnique({
      where: {
        serviceType: dto.serviceType,
      },
    });

    if (existingCategory) {
      return this.prisma.serviceCategory.update({
        where: {
          serviceType: dto.serviceType,
        },
        data: {
          name: dto.name,
          description: dto.description,
          isActive: dto.isActive ?? existingCategory.isActive,
        },
        include: {
          subServices: {
            orderBy: {
              name: 'asc',
            },
          },
        },
      });
    }

    return this.prisma.serviceCategory.create({
      data: {
        serviceType: dto.serviceType,
        name: dto.name,
        description: dto.description,
        isActive: dto.isActive ?? true,
      },
      include: {
        subServices: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });
  }

  async findAllCategoriesAdmin(params?: {
    includeInactive?: boolean;
    search?: string;
  }) {
    const where: Prisma.ServiceCategoryWhereInput = {};

    if (!params?.includeInactive) {
      where.isActive = true;
    }

    if (params?.search) {
      where.OR = [
        {
          name: {
            contains: params.search,
            mode: 'insensitive',
          },
        },
        {
          description: {
            contains: params.search,
            mode: 'insensitive',
          },
        },
      ];
    }

    return this.prisma.serviceCategory.findMany({
      where,
      include: {
        subServices: {
          orderBy: {
            name: 'asc',
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findCategoryAdmin(id: number) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: {
        id,
      },
      include: {
        subServices: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });

    if (!category) {
      throw new NotFoundException('Catégorie introuvable.');
    }

    return category;
  }

  async updateCategory(
    id: number,
    dto: Partial<CreateServiceCategoryDto>,
  ) {
    await this.findCategoryAdmin(id);

    return this.prisma.serviceCategory.update({
      where: {
        id,
      },
      data: {
        name: dto.name,
        description: dto.description,
        isActive: dto.isActive,
      },
      include: {
        subServices: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });
  }

  async activateCategory(id: number) {
    await this.findCategoryAdmin(id);

    return this.prisma.serviceCategory.update({
      where: {
        id,
      },
      data: {
        isActive: true,
      },
      include: {
        subServices: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });
  }

  async deactivateCategory(id: number) {
    await this.findCategoryAdmin(id);

    return this.prisma.serviceCategory.update({
      where: {
        id,
      },
      data: {
        isActive: false,
      },
      include: {
        subServices: {
          orderBy: {
            name: 'asc',
          },
        },
      },
    });
  }

  // ==========================================================
  // 3. ADMIN SUB-SERVICES
  // ==========================================================

  async createSubService(dto: CreateSubServiceDto) {
    const category = await this.prisma.serviceCategory.findUnique({
      where: {
        id: dto.categoryId,
      },
    });

    if (!category) {
      throw new NotFoundException('Catégorie introuvable.');
    }

    const existingSubService = await this.prisma.subService.findFirst({
      where: {
        categoryId: dto.categoryId,
        name: {
          equals: dto.name,
          mode: 'insensitive',
        },
      },
    });

    if (existingSubService) {
      throw new BadRequestException(
        'Ce sous-service existe déjà dans cette catégorie.',
      );
    }

    return this.prisma.subService.create({
      data: {
        categoryId: dto.categoryId,
        name: dto.name,
        description: dto.description,
        estimatedDuration: dto.estimatedDuration,
        basePrice: dto.basePrice,
        emergencyPrice: dto.emergencyPrice,
        requiresPhotos: dto.requiresPhotos ?? false,
        isActive: dto.isActive ?? true,
      },
      include: {
        category: true,
      },
    });
  }

  async findAllSubServicesAdmin(params?: {
    categoryId?: number;
    includeInactive?: boolean;
    search?: string;
  }) {
    const where: Prisma.SubServiceWhereInput = {};

    if (params?.categoryId) {
      where.categoryId = params.categoryId;
    }

    if (!params?.includeInactive) {
      where.isActive = true;
    }

    if (params?.search) {
      where.OR = [
        {
          name: {
            contains: params.search,
            mode: 'insensitive',
          },
        },
        {
          description: {
            contains: params.search,
            mode: 'insensitive',
          },
        },
      ];
    }

    return this.prisma.subService.findMany({
      where,
      include: {
        category: true,
      },
      orderBy: [
        {
          categoryId: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  async findSubServiceAdmin(id: number) {
    const subService = await this.prisma.subService.findUnique({
      where: {
        id,
      },
      include: {
        category: true,
      },
    });

    if (!subService) {
      throw new NotFoundException('Sous-service introuvable.');
    }

    return subService;
  }

  async updateSubService(
    id: number,
    dto: Partial<CreateSubServiceDto>,
  ) {
    const existingSubService = await this.findSubServiceAdmin(id);

    if (dto.categoryId) {
      const category = await this.prisma.serviceCategory.findUnique({
        where: {
          id: dto.categoryId,
        },
      });

      if (!category) {
        throw new NotFoundException('Catégorie introuvable.');
      }
    }

    if (dto.name) {
      const duplicate = await this.prisma.subService.findFirst({
        where: {
          id: {
            not: id,
          },
          categoryId: dto.categoryId || existingSubService.categoryId,
          name: {
            equals: dto.name,
            mode: 'insensitive',
          },
        },
      });

      if (duplicate) {
        throw new BadRequestException(
          'Un autre sous-service porte déjà ce nom dans cette catégorie.',
        );
      }
    }

    return this.prisma.subService.update({
      where: {
        id,
      },
      data: {
        categoryId: dto.categoryId,
        name: dto.name,
        description: dto.description,
        estimatedDuration: dto.estimatedDuration,
        basePrice: dto.basePrice,
        emergencyPrice: dto.emergencyPrice,
        requiresPhotos: dto.requiresPhotos,
        isActive: dto.isActive,
      },
      include: {
        category: true,
      },
    });
  }

  async activateSubService(id: number) {
    await this.findSubServiceAdmin(id);

    return this.prisma.subService.update({
      where: {
        id,
      },
      data: {
        isActive: true,
      },
      include: {
        category: true,
      },
    });
  }

  async deactivateSubService(id: number) {
    await this.findSubServiceAdmin(id);

    return this.prisma.subService.update({
      where: {
        id,
      },
      data: {
        isActive: false,
      },
      include: {
        category: true,
      },
    });
  }

  async removeSubService(id: number) {
    return this.deactivateSubService(id);
  }

  async deleteSubService(id: number) {
    await this.findSubServiceAdmin(id);

    const interventionsCount = await this.prisma.intervention.count({
      where: {
        subServiceId: id,
      },
    });

    if (interventionsCount > 0) {
      await this.prisma.subService.update({
        where: {
          id,
        },
        data: {
          isActive: false,
        },
      });

      return {
        message:
          'Sous-service utilisé par des interventions. Il a été désactivé au lieu d’être supprimé.',
      };
    }

    await this.prisma.subService.delete({
      where: {
        id,
      },
    });

    return {
      message: 'Sous-service supprimé avec succès.',
    };
  }
}