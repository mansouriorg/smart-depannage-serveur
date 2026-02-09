import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from 'generated/prisma/client'; // Your custom path
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    // 1. Create the Postgres Pool
    const connectionString = config.get<string>('DATABASE_URL');
    const pool = new Pool({ connectionString });

    // 2. Create the Prisma Adapter
    const adapter = new PrismaPg(pool);

    // 3. Pass the adapter to the parent PrismaClient constructor
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}