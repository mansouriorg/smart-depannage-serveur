import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateArtisanApplicationDto } from './dto/create-artisan-application.dto';
import * as argon2 from 'argon2';
import { Role } from '../../../generated/prisma/client'; // Adjust path if needed

@Injectable()
export class ArtisanApplicationsService {
  constructor(private prisma: PrismaService) {}

  // 1. Submit Application (Public)
  async create(dto: CreateArtisanApplicationDto) {
    const existing = await this.prisma.artisanApplication.findFirst({
      where: { email: dto.email },
    });
    if (existing) throw new BadRequestException('Une candidature existe déjà pour cet email.');

    return this.prisma.artisanApplication.create({
      data: {
        ...dto,
        status: 'PENDING',
      },
    });
  }

  // 2. List All (Admin Only)
  async findAll() {
    return this.prisma.artisanApplication.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  // 3. APPROVE APPLICATION (The Magic Part)
  async approve(id: number) {
    // A. Find the application
    const application = await this.prisma.artisanApplication.findUnique({ where: { id } });
    if (!application) throw new NotFoundException('Candidature introuvable.');
    if (application.status === 'APPROVED') throw new BadRequestException('Déjà approuvé.');

    // B. Create the Real User Account
    // We generate a temporary password (e.g. "Artisan2026!")
    const hashedPassword = await argon2.hash('Artisan2026!'); 

    const newUser = await this.prisma.user.create({
      data: {
        name: application.name,
        email: application.email,
        phone: application.phone,
        password: hashedPassword,
        role: Role.ARTISAN, // ✅ Critical: Give them the Artisan role
        // You could also save their specialty in a separate profile table here
      },
    });

    // C. Update Application Status
    await this.prisma.artisanApplication.update({
      where: { id },
      data: { status: 'APPROVED' },
    });

    return { message: "Artisan approuvé et compte créé !", user: newUser };
  }

  // 4. Reject Application
  async reject(id: number) {
    return this.prisma.artisanApplication.update({
      where: { id },
      data: { status: 'REJECTED' },
    });
  }
}