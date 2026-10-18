import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ServiceZonesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The list an applicant picks from (the /rejoindre form and the back office's invite form).
   * Only zones that can be chosen: switched on and with a centre. Nothing but the number, the
   * name and the city leaves the server: the centre and the radius are the platform's business.
   */
  findPublic() {
    return this.prisma.adminServiceZone.findMany({
      where: { isActive: true, latitude: { not: null }, longitude: { not: null } },
      select: { id: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
  }
}
