import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses process environment into typed config and fails fast on startup.
 * Error messages name the offending variables but never echo their values,
 * because values such as DATABASE_URL contain credentials.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
