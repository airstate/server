import { z } from 'zod';

export const configSchema = z.object({
    signing_secret: z.string().optional(),
    accounting_identifier: z.string().optional(),
});

export type TConfig = z.infer<typeof configSchema>;
