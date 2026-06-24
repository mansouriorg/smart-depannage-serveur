import { Role } from '../../../../generated/prisma/client';

export type AuthenticatedUser = {
  id: number;
  email: string;
  name?: string | null;
  role: Role;
};