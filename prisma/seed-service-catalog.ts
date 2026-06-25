import 'dotenv/config';

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

import {
  PrismaClient,
  ServiceType,
} from '../generated/prisma/client';

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

type SeedSubService = {
  name: string;
  description: string;
  estimatedDuration: number;
  basePrice: number;
  emergencyPrice: number;
  requiresPhotos: boolean;
  isActive?: boolean;
};

type SeedCategory = {
  serviceType: ServiceType;
  name: string;
  description: string;
  subServices: SeedSubService[];
};

const catalog: SeedCategory[] = [
  {
    serviceType: ServiceType.PLOMBIER,
    name: 'Plomberie',
    description:
      'Services de plomberie pour les fuites, installations, débouchages, chauffe-eau et urgences.',
    subServices: [
      {
        name: 'Fuite d’eau',
        description:
          'Recherche et réparation d’une fuite visible sous évier, lavabo, douche, WC ou canalisation accessible.',
        estimatedDuration: 60,
        basePrice: 89,
        emergencyPrice: 139,
        requiresPhotos: true,
      },
      {
        name: 'Débouchage canalisation',
        description:
          'Débouchage d’évier, lavabo, douche, baignoire, WC ou canalisation obstruée.',
        estimatedDuration: 75,
        basePrice: 119,
        emergencyPrice: 169,
        requiresPhotos: true,
      },
      {
        name: 'Remplacement robinet',
        description:
          'Dépose et remplacement d’un robinet, mitigeur ou mélangeur fourni ou à fournir.',
        estimatedDuration: 60,
        basePrice: 99,
        emergencyPrice: 149,
        requiresPhotos: true,
      },
      {
        name: 'Installation WC',
        description:
          'Installation, remplacement ou réparation d’un WC classique ou suspendu.',
        estimatedDuration: 120,
        basePrice: 189,
        emergencyPrice: 249,
        requiresPhotos: true,
      },
      {
        name: 'Chauffe-eau',
        description:
          'Diagnostic, réparation ou remplacement d’un chauffe-eau électrique selon la panne constatée.',
        estimatedDuration: 120,
        basePrice: 149,
        emergencyPrice: 229,
        requiresPhotos: true,
      },
      {
        name: 'Recherche de fuite',
        description:
          'Diagnostic approfondi pour localiser l’origine d’une fuite visible ou suspectée.',
        estimatedDuration: 90,
        basePrice: 129,
        emergencyPrice: 199,
        requiresPhotos: true,
      },
      {
        name: 'Urgence plomberie',
        description:
          'Intervention urgente pour fuite importante, dégât des eaux, canalisation bouchée ou panne critique.',
        estimatedDuration: 90,
        basePrice: 149,
        emergencyPrice: 249,
        requiresPhotos: true,
      },
    ],
  },
  {
    serviceType: ServiceType.SERRURIER,
    name: 'Serrurerie',
    description:
      'Services de serrurerie pour ouvertures de porte, remplacement de serrure, clés cassées et urgences.',
    subServices: [
      {
        name: 'Ouverture de porte',
        description:
          'Ouverture de porte claquée ou verrouillée selon le type de porte et de serrure.',
        estimatedDuration: 45,
        basePrice: 99,
        emergencyPrice: 159,
        requiresPhotos: true,
      },
      {
        name: 'Remplacement serrure',
        description:
          'Remplacement d’une serrure défectueuse, cassée, bloquée ou non sécurisée.',
        estimatedDuration: 75,
        basePrice: 139,
        emergencyPrice: 199,
        requiresPhotos: true,
      },
      {
        name: 'Blindage porte',
        description:
          'Renforcement de porte avec solution de blindage ou sécurité complémentaire.',
        estimatedDuration: 180,
        basePrice: 399,
        emergencyPrice: 499,
        requiresPhotos: true,
      },
      {
        name: 'Clé cassée',
        description:
          'Extraction d’une clé cassée dans la serrure et remise en fonctionnement si possible.',
        estimatedDuration: 45,
        basePrice: 89,
        emergencyPrice: 149,
        requiresPhotos: true,
      },
      {
        name: 'Installation serrure',
        description:
          'Pose d’une nouvelle serrure simple, multipoints ou sécurisée.',
        estimatedDuration: 90,
        basePrice: 159,
        emergencyPrice: 229,
        requiresPhotos: true,
      },
      {
        name: 'Urgence serrurier',
        description:
          'Intervention rapide en cas de porte bloquée, perte de clés, tentative d’effraction ou serrure cassée.',
        estimatedDuration: 45,
        basePrice: 129,
        emergencyPrice: 219,
        requiresPhotos: true,
      },
    ],
  },
  {
    serviceType: ServiceType.ELECTRICIEN,
    name: 'Électricité',
    description:
      'Services électriques pour pannes, tableaux électriques, prises, courts-circuits et diagnostics.',
    subServices: [
      {
        name: 'Panne électrique',
        description:
          'Diagnostic et réparation d’une panne électrique partielle ou générale.',
        estimatedDuration: 75,
        basePrice: 99,
        emergencyPrice: 169,
        requiresPhotos: true,
      },
      {
        name: 'Tableau électrique',
        description:
          'Diagnostic, réparation, remplacement ou ajout d’éléments au tableau électrique.',
        estimatedDuration: 150,
        basePrice: 249,
        emergencyPrice: 349,
        requiresPhotos: true,
      },
      {
        name: 'Installation prise',
        description:
          'Installation, remplacement ou déplacement d’une prise électrique.',
        estimatedDuration: 60,
        basePrice: 89,
        emergencyPrice: 139,
        requiresPhotos: true,
      },
      {
        name: 'Court-circuit',
        description:
          'Recherche de court-circuit, sécurisation de l’installation et remise en service.',
        estimatedDuration: 90,
        basePrice: 129,
        emergencyPrice: 199,
        requiresPhotos: true,
      },
      {
        name: 'Mise aux normes',
        description:
          'Travaux de conformité, sécurisation et amélioration de l’installation électrique.',
        estimatedDuration: 180,
        basePrice: 299,
        emergencyPrice: 399,
        requiresPhotos: true,
      },
      {
        name: 'Diagnostic électrique',
        description:
          'Contrôle de l’installation, recherche d’anomalies et recommandations de travaux.',
        estimatedDuration: 90,
        basePrice: 119,
        emergencyPrice: 179,
        requiresPhotos: true,
      },
    ],
  },
  {
    serviceType: ServiceType.MENUISIER,
    name: 'Menuiserie',
    description:
      'Services de menuiserie pour portes, fenêtres, volets, meubles et petites réparations.',
    subServices: [
      {
        name: 'Réparation porte',
        description:
          'Réparation, ajustement, rabotage ou remplacement d’éléments de porte.',
        estimatedDuration: 90,
        basePrice: 119,
        emergencyPrice: 169,
        requiresPhotos: true,
      },
      {
        name: 'Réparation fenêtre',
        description:
          'Réparation d’une fenêtre, poignée, joint, fermeture ou élément de vitrage simple.',
        estimatedDuration: 90,
        basePrice: 119,
        emergencyPrice: 169,
        requiresPhotos: true,
      },
      {
        name: 'Pose meuble',
        description:
          'Montage, pose, ajustement ou fixation de meuble mural, placard ou élément intérieur.',
        estimatedDuration: 120,
        basePrice: 149,
        emergencyPrice: 199,
        requiresPhotos: true,
      },
      {
        name: 'Réparation volet',
        description:
          'Diagnostic et réparation de volet roulant, battant, manuel ou motorisé selon le cas.',
        estimatedDuration: 90,
        basePrice: 129,
        emergencyPrice: 189,
        requiresPhotos: true,
      },
      {
        name: 'Ajustement menuiserie',
        description:
          'Ajustement de porte, placard, tiroir, charnière, poignée ou fermeture.',
        estimatedDuration: 60,
        basePrice: 89,
        emergencyPrice: 139,
        requiresPhotos: true,
      },
    ],
  },
  {
    serviceType: ServiceType.AUTRE,
    name: 'Autre',
    description:
      'Demandes personnalisées ou petits dépannages ne rentrant pas dans une catégorie standard.',
    subServices: [
      {
        name: 'Diagnostic',
        description:
          'Diagnostic général pour identifier la nature du problème et proposer une solution.',
        estimatedDuration: 60,
        basePrice: 79,
        emergencyPrice: 129,
        requiresPhotos: true,
      },
      {
        name: 'Petite réparation',
        description:
          'Petite intervention de dépannage, réparation simple ou ajustement rapide.',
        estimatedDuration: 60,
        basePrice: 89,
        emergencyPrice: 139,
        requiresPhotos: true,
      },
      {
        name: 'Demande personnalisée',
        description:
          'Demande spécifique nécessitant une analyse par l’administration avant devis.',
        estimatedDuration: 60,
        basePrice: 0,
        emergencyPrice: 0,
        requiresPhotos: true,
      },
    ],
  },
];

async function main() {
  for (const categoryData of catalog) {
    const category = await prisma.serviceCategory.upsert({
      where: {
        serviceType: categoryData.serviceType,
      },
      update: {
        name: categoryData.name,
        description: categoryData.description,
        isActive: true,
      },
      create: {
        serviceType: categoryData.serviceType,
        name: categoryData.name,
        description: categoryData.description,
        isActive: true,
      },
    });

    for (const subServiceData of categoryData.subServices) {
      const existingSubService = await prisma.subService.findFirst({
        where: {
          categoryId: category.id,
          name: subServiceData.name,
        },
      });

      if (existingSubService) {
        await prisma.subService.update({
          where: {
            id: existingSubService.id,
          },
          data: {
            description: subServiceData.description,
            estimatedDuration: subServiceData.estimatedDuration,
            basePrice: subServiceData.basePrice,
            emergencyPrice: subServiceData.emergencyPrice,
            requiresPhotos: subServiceData.requiresPhotos,
            isActive: subServiceData.isActive ?? true,
          },
        });
      } else {
        await prisma.subService.create({
          data: {
            categoryId: category.id,
            name: subServiceData.name,
            description: subServiceData.description,
            estimatedDuration: subServiceData.estimatedDuration,
            basePrice: subServiceData.basePrice,
            emergencyPrice: subServiceData.emergencyPrice,
            requiresPhotos: subServiceData.requiresPhotos,
            isActive: subServiceData.isActive ?? true,
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