import { 
  Injectable, 
  ConflictException, 
  NotFoundException, 
  BadRequestException 
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as argon2 from 'argon2';

// ⚠️ IMPORTANT: Assurez-vous que le chemin vers votre client Prisma est correct
import { Prisma, User, Role } from '../../../generated/prisma/client'; 

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  // ==========================================================
  // 1. CREATE (Register / Manual Add)
  // ==========================================================
  async create(data: Prisma.UserCreateInput): Promise<User> {
    // 1. Check if email exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictException('Cet email est déjà utilisé.');
    }

    // 2. Hash the password before saving
    const hashedPassword = await argon2.hash(data.password);

    // 3. Save to DB
    return this.prisma.user.create({
      data: {
        ...data,
        password: hashedPassword,
        isActive: true, // ✅ Explicitly set active on creation
      },
    });
  }

  // ==========================================================
  // 2. FIND ALL (Updated to support Filtering)
  // ==========================================================
  // ✅ Allows finding ALL users OR filtering by Role (e.g. Artisans)
  async findAll(params?: { where?: Prisma.UserWhereInput }): Promise<User[]> {
    const { where } = params || {};
    
    return this.prisma.user.findMany({
      where, 
      orderBy: { id: 'desc' }, // Show newest users first
    });
  }

  // ==========================================================
  // 3. FIND ONE (Used by Controller & Auth)
  // ==========================================================
  async findOne(id: number): Promise<User | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });
    
    if (!user) throw new NotFoundException(`Utilisateur #${id} introuvable`);
    return user;
  }

  // Helper for Auth (Login)
  async findOneByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  // ==========================================================
  // 4. UPDATE (Used by Controller)
  // ==========================================================
  async update(id: number, data: Prisma.UserUpdateInput): Promise<User> {
    // If password is being updated, hash it again
    if (data.password && typeof data.password === 'string') {
      data.password = await argon2.hash(data.password);
    }

    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  // ==========================================================
  // 5. REMOVE (Soft Delete / Ban)
  // ==========================================================
  async remove(id: number): Promise<User> {
    // Check if user exists first
    await this.findOne(id);

    // ✅ UPDATED: We DO NOT delete the row. We just set isActive = false.
    // This preserves the history of their interventions.
    return this.prisma.user.update({
      where: { id },
      data: {
        isActive: false, 
      },
    });
  }

  // ==========================================================
  // 6. UPDATE LOCATION (GPS) 📍 
  // ==========================================================
  // Cette fonction est appelée par l'application mobile de l'artisan
  async updateLocation(id: number, latitude: number, longitude: number): Promise<User> {
    // On vérifie d'abord que l'utilisateur existe
    await this.findOne(id);

    return this.prisma.user.update({
      where: { id },
      data: {
        latitude: latitude,
        longitude: longitude,
      },
    });
  }

  // ==========================================================
  // 7. CREATE ARTISAN DIRECTLY (Admin Dashboard)
  // ==========================================================
  async createArtisanDirectly(data: { name: string; email: string; phone: string; specialty?: string }): Promise<User> {
    // 1. Check if email already exists
    const existingUser = await this.prisma.user.findUnique({ 
      where: { email: data.email } 
    });
    
    if (existingUser) {
      throw new BadRequestException('Cet email est déjà utilisé.');
    }

    // 2. Generate a secure temporary password
    const hashedPassword = await argon2.hash('Artisan2026!');

    // 3. Create the user
    return this.prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        password: hashedPassword,
        role: Role.ARTISAN,
        isActive: true, 
      },
    });
  }

  // ==========================================================
  // 8. 👤 GET PROFILE (Admin / User Settings)
  // ==========================================================
  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { 
        id: true, 
        name: true, 
        email: true, 
        phone: true, 
        role: true,
        address: true, // ✅ Nouveaux champs inclus
        taxId: true,
        website: true
      } 
    });
    
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    return user;
  }

  // ==========================================================
  // 9. ✏️ UPDATE PROFILE (Admin / User Settings)
  // ==========================================================
  async updateProfile(userId: number, updateData: { 
    name?: string; 
    email?: string; 
    phone?: string; 
    address?: string; 
    taxId?: string; 
    website?: string 
  }) {
    return this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { 
        id: true, 
        name: true, 
        email: true, 
        phone: true,
        address: true,
        taxId: true,
        website: true
      } 
    });
  }
}