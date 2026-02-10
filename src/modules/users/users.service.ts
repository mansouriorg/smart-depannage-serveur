import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as argon2 from 'argon2';

// ⚠️ IMPORTANT: Use your custom generated path
import { Prisma, User } from '../../../generated/prisma/client'; 

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  // ==========================================================
  // 1. CREATE (Register)
  // ==========================================================
  async create(data: Prisma.UserCreateInput): Promise<User> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const hashedPassword = await argon2.hash(data.password);

    return this.prisma.user.create({
      data: {
        ...data,
        password: hashedPassword,
      },
    });
  }

  // ==========================================================
  // 2. FIND ALL (Updated to support Filtering)
  // ==========================================================
  // ✅ NOW ACCEPTS PARAMETERS (e.g. { where: { role: 'ARTISAN' } })
  async findAll(params?: { where?: Prisma.UserWhereInput }): Promise<User[]> {
    const { where } = params || {};
    
    return this.prisma.user.findMany({
      where, 
      orderBy: { id: 'desc' }, 
      // Security: We generally shouldn't return passwords, 
      // but for internal admin use, we often keep the object as is.
    });
  }

  // ==========================================================
  // 3. FIND ONE (Used by Controller & Auth)
  // ==========================================================
  async findOne(id: number): Promise<User | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });
    
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  // Helper for Auth (Keep this!)
  async findOneByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  // ==========================================================
  // 4. UPDATE (Used by Controller)
  // ==========================================================
  async update(id: number, data: Prisma.UserUpdateInput): Promise<User> {
    // Optional: Hash password if it's being updated
    if (data.password && typeof data.password === 'string') {
      data.password = await argon2.hash(data.password);
    }

    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  // ==========================================================
  // 5. REMOVE (Used by Controller)
  // ==========================================================
  async remove(id: number): Promise<User> {
    return this.prisma.user.delete({
      where: { id },
    });
  }
}