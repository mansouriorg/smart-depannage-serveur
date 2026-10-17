import { Role } from '../../../../generated/prisma/client';

export type AuthenticatedUser = {
  id: number;
  /**
   * @deprecated Alias of `id`, kept only for the legacy interventions
   * controllers. New code must use `id`. Removed in P3-03.
   */
  userId: number;
  email: string;
  name?: string | null;
  role: Role;
};
