import { PrismaClient, Role, ServiceType } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seeding...');

  // 1. Create a password hash
  const password = await argon2.hash('password123');

  // 2. Create an Admin User
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

  // 3. Create a Client
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

  // 4. Create an Artisan (Plombier)
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

  // 5. Create a Dummy Request (Intervention)
  const intervention = await prisma.intervention.create({
    data: {
      description: 'Fuite d\'eau dans la cuisine',
      address: '15 Rue de Paris, Tunis',
      serviceType: ServiceType.PLOMBIER,
      status: 'PENDING',
      client: { connect: { id: client.id } }, // Connect to the client we just made
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
    await prisma.$disconnect();
  });