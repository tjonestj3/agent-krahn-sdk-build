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
  SLACK_BOT_TOKEN: required('SLACK_BOT_TOKEN'),
  SLACK_SIGNING_SECRET: required('SLACK_SIGNING_SECRET'),
  SLACK_USER_EMAIL: process.env.SLACK_USER_EMAIL ?? 'thomas@krahnborn.com',
  SLACK_USER_NAME_FALLBACK: process.env.SLACK_USER_NAME_FALLBACK ?? 'Thomas Jones',
  GITHUB_WEBHOOK_SECRET: required('GITHUB_WEBHOOK_SECRET'),
  PORT: Number(process.env.PORT ?? 3000),
  VAULT_PATH: process.env.KRAHNBORN_VAULT_PATH ?? `${process.env.HOME}/vault`,
} as const;
