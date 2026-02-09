// 1. Load environment variables
import 'dotenv/config';

// 2. Import dependencies
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, ServiceType } from '../generated/prisma/client'; // Your custom path
import * as argon2 from 'argon2';

// 3. Setup the Database Adapter (REQUIRED for Prisma 7 No-Rust Engine)
const connectionString = process.env.DATABASE_URL;

// Create a Postgres connection pool
const pool = new Pool({ connectionString });
// Create the Prisma adapter
const adapter = new PrismaPg(pool);
// Pass the adapter to the client
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting seeding...');

  // 4. Create a password hash
  const password = await argon2.hash('password123');

  // 5. Create an Admin User
  const admin = await prisma.user.upsert({
    where: { email: 'admin@smart-depannage.com' },
    update: {},
    create: {
      email: 'admin@smart-depannage.com',
      password,
      name: 'Super Admin',
      role: Role.ADMIN,
      phone: '21600000000',
    },
  });
  console.log(`Created Admin: ${admin.email}`);

  // 6. Create a Client
  const client = await prisma.user.upsert({
    where: { email: 'client@gmail.com' },
    update: {},
    create: {
      email: 'client@gmail.com',
      password,
      name: 'Monsieur Client',
      role: Role.CLIENT,
      phone: '21699999999',
    },
  });
  console.log(`Created Client: ${client.email}`);

  // 7. Create an Artisan (Plombier)
  const plumber = await prisma.user.upsert({
    where: { email: 'plombier@gmail.com' },
    update: {},
    create: {
      email: 'plombier@gmail.com',
      password,
      name: 'Ahmed Plombier',
      role: Role.ARTISAN,
      phone: '21655555555',
    },
  });
  console.log(`Created Artisan: ${plumber.email}`);

  // 8. Create a Dummy Request (Intervention)
  // Ensure 'intervention' model exists in your schema.prisma
  const intervention = await prisma.intervention.create({
    data: {
      description: "Fuite d'eau dans la cuisine",
      address: '15 Rue de Paris, Tunis',
      serviceType: ServiceType.PLOMBIER,
      status: 'PENDING',
      client: { connect: { id: client.id } },
    },
  });
  console.log(`Created Intervention: #${intervention.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    // 9. Close the connection
    await prisma.$disconnect();
    await pool.end(); // Close the pool explicitly to ensure the script exits
  });