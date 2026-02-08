import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service'; // Adjust path if needed
import { Prisma, User } from '@prisma/client';
import * as argon2 from 'argon2';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  // 1. Create a new User (Client or Artisan)
  async create(data: Prisma.UserCreateInput): Promise<User> {
    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    // Hash the password using Argon2
    const hashedPassword = await argon2.hash(data.password);

    // Save to database
    // We use 'omit' or manually select fields to avoid returning the password, 
    // but for now, let's just create the user.
    const user = await this.prisma.user.create({
      data: {
        ...data,
        password: hashedPassword,
      },
    });

    return user;
  }

  // 2. Find a user by Email (Used for Login)
  async findOneByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  // 3. Find a user by ID
  async findOneById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }
}