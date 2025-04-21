import { z } from 'zod';

export const configSchema = z.object({
    signing_secret: z.string().optional(),
    accounting_identifier: z.string().optional(),
    init_logs: z
        .array(
            z.object({
                level: z.enum(['debug', 'info', 'warning', 'error']),
                arguments: z.string().array(),
            }),
        )
        .optional(),
    init_error: z.string().optional(),
    close_after_init: z.boolean().optional(),
});

export type TConfig = z.infer<typeof configSchema>;
