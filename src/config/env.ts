import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: required('SUPABASE_SERVICE_KEY'),
  KRAHNBORN_API_TOKEN: required('KRAHNBORN_API_TOKEN'),
  PORT: Number(process.env.PORT ?? 3000),
  VAULT_PATH: process.env.KRAHNBORN_VAULT_PATH ?? `${process.env.HOME}/vault`,
} as const;
