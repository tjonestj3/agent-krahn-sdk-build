import { WebClient } from '@slack/web-api';
import { env } from '../config/env.js';

let _client: WebClient | null = null;
let _recipientId: string | null = null;
let _recipientLookupPromise: Promise<string | null> | null = null;

export function slackClient(): WebClient {
  if (!_client) {
    _client = new WebClient(env.SLACK_BOT_TOKEN);
  }
  return _client;
}

/**
 * Resolve the human's Slack user_id once and cache it. Tries
 * users.lookupByEmail first; falls back to scanning users.list for a
 * real_name / display_name match against SLACK_USER_NAME_FALLBACK.
 *
 * Returns null if neither path finds a user — callers should log and
 * skip the notification rather than crashing the pipeline.
 */
export async function getRecipientUserId(): Promise<string | null> {
  if (_recipientId) return _recipientId;
  if (_recipientLookupPromise) return _recipientLookupPromise;

  _recipientLookupPromise = (async () => {
    const client = slackClient();

    try {
      const byEmail = await client.users.lookupByEmail({
        email: env.SLACK_USER_EMAIL,
      });
      if (byEmail.ok && byEmail.user?.id) {
        _recipientId = byEmail.user.id;
        return _recipientId;
      }
    } catch {
      // fall through to fallback
    }

    try {
      let cursor: string | undefined;
      const wantName = env.SLACK_USER_NAME_FALLBACK.toLowerCase();
      do {
        const page = await client.users.list(
          cursor ? { limit: 200, cursor } : { limit: 200 },
        );
        for (const u of page.members ?? []) {
          if (u.deleted || u.is_bot) continue;
          const real = (u.real_name ?? '').toLowerCase();
          const display = (u.profile?.display_name ?? '').toLowerCase();
          if (real === wantName || display === wantName) {
            _recipientId = u.id ?? null;
            if (_recipientId) return _recipientId;
          }
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch {
      // give up
    }

    return null;
  })();

  const resolved = await _recipientLookupPromise;
  _recipientLookupPromise = null;
  return resolved;
}
