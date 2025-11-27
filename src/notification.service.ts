// services/notification.service.ts

import { getContext, getEnv, requireAuth } from "@getcronit/pylon";
import { InvalidInputError } from "./errors/general.errors";
import {
  UserService,
  UserPushSubscription
} from "./user.service";

import { buildPushHTTPRequest } from "@pushforge/builder";

export type PushSubscription = UserPushSubscription;

// ---------- VAPID / PushForge config helpers ----------

/**
 * Load VAPID config from Worker env.
 *
 * Expect:
 * - VAPID_PRIVATE_KEY: the JSON JWK string
 *   printed by `@pushforge/builder generate-vapid-keys` under "Private Key (JWK)".
 * - VAPID_SUBJECT: e.g. "mailto:you@example.com"
 */
function getVapidConfig(): { privateJWK: JsonWebKey; adminContact: string } {
  const env: any = getEnv();

  const raw =
    env?.VAPID_PRIVATE_KEY ??
    env?.VAPID_PRIVATE_JWK; // allow both names, in case you rename later

  if (!raw) {
    throw new Error(
      "Missing VAPID_PRIVATE_KEY (or VAPID_PRIVATE_JWK) env var containing the VAPID private JWK JSON."
    );
  }

  let privateJWK: JsonWebKey;

  if (typeof raw === "string") {
    try {
      privateJWK = JSON.parse(raw) as JsonWebKey;
    } catch (e) {
      // Log a tiny snippet so you can see if you accidentally pasted the old web-push key
      console.error(
        "VAPID_PRIVATE_KEY is not valid JSON JWK. First chars:",
        raw.slice(0, 40)
      );
      throw new Error(
        "VAPID_PRIVATE_KEY must be the JSON JWK printed by `@pushforge/builder generate-vapid-keys` under 'Private Key (JWK)'."
      );
    }
  } else {
    // In case some runtime gives you an object already
    privateJWK = raw as JsonWebKey;
  }

  const adminContact: string =
    env?.VAPID_SUBJECT || "mailto:support@limosen.at";

  return { privateJWK, adminContact };
}

/**
 * Build a PushForge message object from our payload + admin contact.
 */
function buildMessageFromPayload(
  payload:
    | {
        title: string;
        body?: string;
        icon?: string;
        data?: any;
        [key: string]: any;
      }
    | undefined,
  adminContact: string
) {
  const effectivePayload =
    payload ??
    ({
      title: "LIMOSEN",
      body: "You have a new notification.",
      icon: "/icons/icon-192x192.png"
    } as const);

  return {
    payload: effectivePayload,
    options: {
      // 1 hour TTL is usually enough for transfer updates
      ttl: 3600,
      urgency: "normal" as const
      // topic: "limosen-updates" // optional
    },
    adminContact
  };
}

/**
 * Convert our stored subscription to the shape PushForge expects.
 */
function toPushForgeSubscription(sub: PushSubscription) {
  if (!sub.endpoint) return null;

  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;

  if (!p256dh || !auth) {
    // Subscription is incomplete; can't encrypt payload for it.
    console.warn(
      "Skipping subscription without p256dh/auth keys",
      sub.endpoint
    );
    return null;
  }

  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh,
      auth
    }
  };
}

/**
 * Service for managing web push notification subscriptions per user.
 * Subscriptions are stored as JSON array in user metadata via
 * UserService.getUserPushSubscriptions / setUserPushSubscriptions.
 *
 * This service also acts as a push "service" by building HTTP requests
 * via @pushforge/builder and sending them directly to the push endpoints.
 */
export class NotificationService {
  // --------------------------------------------------
  // Push subscriptions metadata management
  // --------------------------------------------------

  /**
   * Get raw push subscriptions for a user (may be null if not set).
   */
  static async getUserPushSubscriptions(
    userId: string,
    organizationId?: string
  ): Promise<PushSubscription[] | null> {
    return UserService.getUserPushSubscriptions(userId, organizationId);
  }

  /**
   * Set push subscriptions array for a user (overwrites existing).
   */
  static async setUserPushSubscriptions(
    userId: string,
    subscriptions: PushSubscription[],
    organizationId?: string
  ) {
    return UserService.setUserPushSubscriptions(
      userId,
      subscriptions,
      organizationId
    );
  }

  /**
   * Add or update a push subscription for a user.
   * Deduplicates by endpoint.
   */
  static async addUserPushSubscription(
    userId: string,
    subscription: PushSubscription,
    organizationId?: string
  ): Promise<PushSubscription[]> {
    const existing =
      (await NotificationService.getUserPushSubscriptions(
        userId,
        organizationId
      )) ?? [];

    // Remove any previous subscription with the same endpoint
    const filtered = existing.filter(
      (s) => s && s.endpoint !== subscription.endpoint
    );

    const updated = [...filtered, subscription];
    await NotificationService.setUserPushSubscriptions(
      userId,
      updated,
      organizationId
    );

    return updated;
  }

  /**
   * Remove a single subscription by endpoint.
   */
  static async removeUserPushSubscription(
    userId: string,
    endpoint: string,
    organizationId?: string
  ): Promise<PushSubscription[]> {
    const existing =
      (await NotificationService.getUserPushSubscriptions(
        userId,
        organizationId
      )) ?? [];

    const updated = existing.filter((s) => s && s.endpoint !== endpoint);
    await NotificationService.setUserPushSubscriptions(
      userId,
      updated,
      organizationId
    );

    return updated;
  }

  /**
   * Clear all push subscriptions for a user.
   */
  static async clearUserPushSubscriptions(
    userId: string,
    organizationId?: string
  ) {
    return NotificationService.setUserPushSubscriptions(
      userId,
      [],
      organizationId
    );
  }

  // --------------------------------------------------
  // Helpers for "current user" (via auth.sub)
  // --------------------------------------------------

  /**
   * Convenience helper: get subscriptions of the currently authenticated user.
   */
  @requireAuth()
  static async getCurrentUserPushSubscriptions(
    organizationId?: string
  ): Promise<PushSubscription[] | null> {
    const ctx = getContext();
    const auth = ctx.get("auth") as { sub?: string } | undefined;
    if (!auth?.sub) {
      throw new InvalidInputError("Anonymous user has no subscriptions");
    }
    return NotificationService.getUserPushSubscriptions(
      auth.sub,
      organizationId
    );
  }

  /**
   * Convenience helper: add subscription for current user.
   */
  @requireAuth()
  static async addCurrentUserPushSubscription(
    subscription: PushSubscription,
    organizationId?: string
  ): Promise<PushSubscription[]> {
    const ctx = getContext();
    const auth = ctx.get("auth") as { sub?: string } | undefined;
    if (!auth?.sub) {
      throw new InvalidInputError("Anonymous user has no subscriptions");
    }
    return NotificationService.addUserPushSubscription(
      auth.sub,
      subscription,
      organizationId
    );
  }

  /**
   * Convenience helper: remove subscription for current user by endpoint.
   */
  @requireAuth()
  static async removeCurrentUserPushSubscription(
    endpoint: string,
    organizationId?: string
  ): Promise<PushSubscription[]> {
    const ctx = getContext();
    const auth = ctx.get("auth") as { sub?: string } | undefined;
    if (!auth?.sub) {
      throw new InvalidInputError("Anonymous user has no subscriptions");
    }
    return NotificationService.removeUserPushSubscription(
      auth.sub,
      endpoint,
      organizationId
    );
  }

  /**
   * Convenience helper: clear all subscriptions for current user.
   */
  @requireAuth()
  static async clearCurrentUserPushSubscriptions(organizationId?: string) {
    const ctx = getContext();
    const auth = ctx.get("auth") as { sub?: string } | undefined;
    if (!auth?.sub) {
      throw new InvalidInputError("Anonymous user has no subscriptions");
    }
    return NotificationService.clearUserPushSubscriptions(
      auth.sub,
      organizationId
    );
  }

  // --------------------------------------------------
  // Push sending (via @pushforge/builder)
  // --------------------------------------------------

  /**
   * Send a push notification to all subscriptions of a user.
   *
   * Uses @pushforge/builder to handle:
   * - VAPID authentication
   * - Web Push payload encryption
   */
  static async sendNotificationToUser(
    userId: string,
    payload: {
      title: string;
      body?: string;
      icon?: string;
      data?: any;
      [key: string]: any;
    },
    organizationId?: string
  ): Promise<{ delivered: number; failed: number }> {
    const subs =
      (await NotificationService.getUserPushSubscriptions(
        userId,
        organizationId
      )) ?? [];

    if (!subs.length) {
      return { delivered: 0, failed: 0 };
    }

    return NotificationService.sendPushToSubscriptions(subs, payload);
  }

  /**
   * Send a test notification to the currently authenticated user.
   * This is the one your "Test notification" button calls.
   */
  @requireAuth()
  static async sendTestNotificationToCurrentUser(
    organizationId?: string
  ): Promise<{ delivered: number; failed: number }> {
    const ctx = getContext();
    const auth = ctx.get("auth") as { sub?: string } | undefined;
    if (!auth?.sub) {
      throw new InvalidInputError("Anonymous user has no subscriptions");
    }

    const payload = {
      title: "Test notification",
      body: "If you see this, push notifications are working for your account."
    };

    return NotificationService.sendNotificationToUser(
      auth.sub,
      payload,
      organizationId
    );
  }

  /**
   * Low-level helper: send encrypted push notification via PushForge
   * to each subscription in the list.
   */
  private static async sendPushToSubscriptions(
    subscriptions: PushSubscription[],
    payload?: {
      title: string;
      body?: string;
      icon?: string;
      data?: any;
      [key: string]: any;
    }
  ): Promise<{ delivered: number; failed: number }> {
    const { privateJWK, adminContact } = getVapidConfig();

    let delivered = 0;
    let failed = 0;

    for (const sub of subscriptions) {
      const pfSub = toPushForgeSubscription(sub);
      if (!pfSub) {
        failed++;
        continue;
      }

      try {
        const message = buildMessageFromPayload(payload, adminContact);

        const { endpoint, headers, body } = await buildPushHTTPRequest({
          privateJWK,
          message,
          subscription: pfSub
        });

        const res = await fetch(endpoint, {
          method: "POST",
          headers,
          body
        });

        if (res.status === 201) {
          delivered++;
        } else {
          failed++;
          const text = await res.text().catch(() => "");
          console.warn(
            "Push endpoint returned non-201 status",
            res.status,
            "for",
            pfSub.endpoint,
            text
          );
        }
      } catch (e) {
        failed++;
        console.error("Failed to send push via PushForge", e);
      }
    }

    return { delivered, failed };
  }
}
