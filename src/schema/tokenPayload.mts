import { z } from 'zod';

export const tokenPayloadSchema = z
    .object({
        permission: z.enum(['read', 'read-write']),
    })
    .partial();

export type TTokenPayload = z.infer<typeof tokenPayloadSchema>;
