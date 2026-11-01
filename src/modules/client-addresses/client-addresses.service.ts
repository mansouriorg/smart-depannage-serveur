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
    const existing = await this.findOneForClient(clientId, id);

    // The point on the map belongs to the text of the address (P3-05: a request made from a saved address is measured to it, for the arrival time and the
    // route of a dispute). A new text with no new point does not keep the old one: it would send the technician's time and route to the old place.
    // A city that was never given (null) and an empty one are the same text: saving the form again with the field left blank is not a change.
    const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') === (b ?? '');
    const textChanged = (dto.address !== undefined && !same(dto.address, existing.address)) || (dto.city !== undefined && !same(dto.city, existing.city));
    const pointSent = dto.latitude !== undefined || dto.longitude !== undefined;

    if (dto.isDefault) {
      await this.prisma.clientAddress.updateMany({
        where: { clientId },
        data: { isDefault: false },
      });
    }

    return this.prisma.clientAddress.update({
      where: { id },
      data: textChanged && !pointSent ? { ...dto, latitude: null, longitude: null } : dto,
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
