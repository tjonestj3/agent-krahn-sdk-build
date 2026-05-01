import 'dotenv/config';

export function authHeaders(): Record<string, string> {
  const token = process.env.KRAHNBORN_API_TOKEN;
  if (!token) {
    console.error('Missing env var KRAHNBORN_API_TOKEN — set it in .env or your shell.');
    process.exit(2);
  }
  return { Authorization: `Bearer ${token}` };
}
