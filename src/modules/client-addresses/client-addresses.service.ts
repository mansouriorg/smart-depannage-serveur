import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClientAddressDto } from './dto/create-client-address.dto';
import { UpdateClientAddressDto } from './dto/update-client-address.dto';

@Injectable()
export class ClientAddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: number, dto: CreateClientAddressDto) {
    if (dto.isDefault) {
      await this.prisma.clientAddress.updateMany({
        where: { clientId },
        data: { isDefault: false },
      });
    }

    return this.prisma.clientAddress.create({
      data: {
        ...dto,
        clientId,
      },
    });
  }

  async findMine(clientId: number) {
    return this.prisma.clientAddress.findMany({
      where: { clientId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOneForClient(clientId: number, id: number) {
    const address = await this.prisma.clientAddress.findUnique({
      where: { id },
    });

    if (!address) {
      throw new NotFoundException('Adresse introuvable.');
    }

    if (address.clientId !== clientId) {
      throw new ForbiddenException('Accès refusé à cette adresse.');
    }

    return address;
  }

  async update(clientId: number, id: number, dto: UpdateClientAddressDto) {
    await this.findOneForClient(clientId, id);

    if (dto.isDefault) {
      await this.prisma.clientAddress.updateMany({
        where: { clientId },
        data: { isDefault: false },
      });
    }

    return this.prisma.clientAddress.update({
      where: { id },
      data: dto,
    });
  }

  async remove(clientId: number, id: number) {
    await this.findOneForClient(clientId, id);

    await this.prisma.clientAddress.delete({
      where: { id },
    });

    return {
      message: 'Adresse supprimée avec succès.',
    };
  }
}