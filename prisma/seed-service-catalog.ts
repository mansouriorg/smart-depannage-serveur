import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ServiceType } from '../generated/prisma/client';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is missing in your .env file.');
}

const pool = new Pool({
  connectionString: databaseUrl,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  const data = [
    {
      serviceType: ServiceType.PLOMBIER,
      name: 'Plomberie',
      subServices: [
        'Fuite d’eau',
        'Débouchage canalisation',
        'Remplacement robinet',
        'Installation WC',
        'Chauffe-eau',
        'Recherche de fuite',
      ],
    },
    {
      serviceType: ServiceType.SERRURIER,
      name: 'Serrurerie',
      subServices: [
        'Ouverture de porte',
        'Remplacement serrure',
        'Blindage porte',
        'Clé cassée',
        'Installation serrure',
      ],
    },
    {
      serviceType: ServiceType.ELECTRICIEN,
      name: 'Électricité',
      subServices: [
        'Panne électrique',
        'Tableau électrique',
        'Installation prise',
        'Court-circuit',
        'Mise aux normes',
      ],
    },
    {
      serviceType: ServiceType.MENUISIER,
      name: 'Menuiserie',
      subServices: [
        'Réparation porte',
        'Réparation fenêtre',
        'Pose meuble',
        'Réparation volet',
      ],
    },
    {
      serviceType: ServiceType.AUTRE,
      name: 'Autre',
      subServices: [
        'Diagnostic',
        'Petite réparation',
        'Demande personnalisée',
      ],
    },
  ];

  for (const item of data) {
    const category = await prisma.serviceCategory.upsert({
      where: {
        serviceType: item.serviceType,
      },
      update: {
        name: item.name,
        isActive: true,
      },
      create: {
        serviceType: item.serviceType,
        name: item.name,
        isActive: true,
      },
    });

    for (const subServiceName of item.subServices) {
      const existingSubService = await prisma.subService.findFirst({
        where: {
          categoryId: category.id,
          name: subServiceName,
        },
      });

      if (!existingSubService) {
        await prisma.subService.create({
          data: {
            categoryId: category.id,
            name: subServiceName,
            isActive: true,
            requiresPhotos: true,
          },
        });
      }
    }
  }

  console.log('✅ Service catalog seeded successfully.');
}

main()
  .catch((error) => {
    console.error('❌ Error while seeding service catalog:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });