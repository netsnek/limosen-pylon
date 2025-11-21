// services/user.service.ts

import { getContext, getEnv, requireAuth } from "@getcronit/pylon";
import validator from "validator";
import { InvalidInputError } from "./errors/general.errors";
import { EmailOrUsernameAlreadyExistsError, UserNotFoundError } from "./errors/user.errors";

// --------------------------------------------------
// Example interfaces for ZITADEL list users response
// --------------------------------------------------
export interface GetAllUsersResponse {
  details: {
    totalResult: string;       // e.g. "345"
    viewTimestamp: string;     // e.g. "2025-01-17T04:43:59.432613Z"
  };
  result: ZitadelUser[];
}

// --------------------------------------------------
// Project role support
// --------------------------------------------------
export interface ProjectRole {
  key: string;
  displayName?: string;
}

export interface ZitadelUserGrant {
  organizationId?: string;
  creationDate?: string;
  changeDate?: string;
  projectId?: string;
  projectName?: string;
  state?: string;

  // Role objects for this grant (key + optional displayName)
  roles: ProjectRole[];
}

export interface UserRoute {
  start: string;
  end: string;
  price: number;
  vehicle?: string;
}

interface ZitadelUser {
  id: string;
  details: {
    sequence: string;
    creationDate: string;
    changeDate: string;
    resourceOwner: string;
  };
  state: string;                // e.g. "USER_STATE_INITIAL"
  userName: string;
  loginNames: string[];
  preferredLoginName: string;

  // URL to the rendered avatar image (if set in ZITADEL)
  avatarUrl?: string;

  human?: HumanUser;            // Might be undefined if user is not "human"

  // Aggregated user grants (roles per project) for this user (added by this service)
  grants?: ZitadelUserGrant[];

  // Flattened set of roles (key + optional displayName) across all grants (for convenience)
  roles?: ProjectRole[];

  // Revenue stored in user metadata key "revenue" (if present)
  revenue?: number | null;

  // Additional numeric metadata
  transferCount?: number | null;
  monthlyRevenue?: number | null;
  monthlyCount?: number | null;

  // JSON metadata: list of frequently used routes
  routes?: UserRoute[] | null;
}

/**
 * Contains human-specific attributes (profile, email, phone).
 */
export interface HumanUser {
  profile?: {
    firstName?: string;
    lastName?: string;
    displayName?: string;
    preferredLanguage?: string;
  };
  email?: {
    email?: string;
  };
  phone?: Record<string, any>;  // Adjust if you know the exact phone fields
}

// --------------------------------------------------
// Existing user creation response interface
// --------------------------------------------------
interface UserCreateResponse {
  userId: string;
  details: {
    sequence: string;
    creationDate: string;
    resourceOwner: string;
  };
}

// --------------------------------------------------
// New helper types for updates / creds / auth
// --------------------------------------------------
export type UserUpdateInput = {
  // Username change
  username?: string;

  // Human profile
  profile?: {
    givenName?: string;
    familyName?: string;
    displayName?: string;
    preferredLanguage?: string;
  };

  // Email change
  email?: {
    email: string;
  };

  // Phone change
  phone?: {
    phone: string;
  };

  // Admin password set (changeRequired == force change on next login)
  password?: {
    password: string;
    changeRequired?: boolean;
  };
};

export type AuthorizationCreateInput = {
  userId: string;
  projectId?: string;          // either projectId or projectGrantId
  projectGrantId?: string;
  roleKeys: string[];          // application role keys
};

export type AuthorizationUpdateInput = {
  authorizationId: string;     // existing authorization id from ListAuthorizations
  roleKeys: string[];          // new complete set of role keys for that authorization
};

export class UserService {
  @requireAuth()
  static async user() {
    const auth = getContext().get("auth");
    if (!auth?.sub) {
      throw new UserNotFoundError("Anonymous");
    }
    return auth.sub;
  }

  // ---------- helpers ----------
  private static env() {
    return getEnv() as any;
  }

  private static apiKey(): string {
    const env = UserService.env();
    return env?.ORG_USER_MANAGER_TOKEN ?? "API_KEY";
  }

  private static base(): string {
    const env = UserService.env();
    return env?.AUTH_ISSUER;
  }

  private static headers(organizationId?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${UserService.apiKey()}`,
      ...(organizationId ? { "x-zitadel-orgid": organizationId } : {})
    };
  }

  private static async parseOrThrow<T = any>(res: Response): Promise<T> {
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      throw new InvalidInputError(data?.message || `HTTP ${res.status}`);
    }
    return data as T;
  }

  // Base64 helpers for metadata values (ASCII-only, e.g. numeric strings)
  private static encodeMetadataValue(value: string): string {
    const g: any = globalThis as any;
    if (typeof g?.btoa === "function") {
      return g.btoa(value);
    }
    throw new Error("No base64 encoder available for metadata values");
  }

  private static decodeMetadataValue(value: string | undefined | null): string | undefined {
    if (!value) return undefined;
    const g: any = globalThis as any;
    if (typeof g?.atob === "function") {
      try {
        return g.atob(value);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  // Generic helper for numeric metadata
  private static async getUserNumericMetadata(
    userId: string,
    key: string,
    organizationId?: string
  ): Promise<number | null> {
    const url = `${UserService.base()}/management/v1/users/${encodeURIComponent(
      userId
    )}/metadata/${encodeURIComponent(key)}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: UserService.headers(organizationId)
      });

      if (res.status === 404) {
        // No metadata set, but still read body to avoid stalled responses
        await res.text().catch(() => "");
        return null;
      }

      const payload = (await res.json().catch(() => ({}))) as any;

      if (!res.ok) {
        console.error(
          `Failed to fetch metadata "${key}" for user`,
          userId,
          "-",
          payload?.message ?? `HTTP ${res.status}`
        );
        return null;
      }

      const encoded =
        payload?.metadata?.value ??
        payload?.value ??
        (Array.isArray(payload?.result) ? payload.result[0]?.value : undefined);

      const decoded = UserService.decodeMetadataValue(encoded);
      if (!decoded) return null;

      const numeric = parseFloat(decoded);
      if (Number.isNaN(numeric)) {
        return null;
      }

      return numeric;
    } catch (e) {
      console.error(`Error while fetching metadata "${key}" for user`, userId, e);
      return null;
    }
  }

  private static async setUserNumericMetadata(
    userId: string,
    key: string,
    value: number,
    organizationId?: string
  ) {
    const url = `${UserService.base()}/management/v1/users/${encodeURIComponent(
      userId
    )}/metadata/_bulk`;

    const encoded = UserService.encodeMetadataValue(String(value));

    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({
        metadata: [
          {
            key,
            value: encoded
          }
        ]
      })
    });

    return UserService.parseOrThrow(res);
  }

  // Generic helper for JSON metadata
  private static async getUserJsonMetadata<T>(
    userId: string,
    key: string,
    organizationId?: string
  ): Promise<T | null> {
    const url = `${UserService.base()}/management/v1/users/${encodeURIComponent(
      userId
    )}/metadata/${encodeURIComponent(key)}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: UserService.headers(organizationId)
      });

      if (res.status === 404) {
        // No metadata set, but still read body to avoid stalled responses
        await res.text().catch(() => "");
        return null;
      }

      const payload = (await res.json().catch(() => ({}))) as any;

      if (!res.ok) {
        console.error(
          `Failed to fetch metadata "${key}" for user`,
          userId,
          "-",
          payload?.message ?? `HTTP ${res.status}`
        );
        return null;
      }

      const encoded =
        payload?.metadata?.value ??
        payload?.value ??
        (Array.isArray(payload?.result) ? payload.result[0]?.value : undefined);

      const decoded = UserService.decodeMetadataValue(encoded);
      if (!decoded) return null;

      try {
        return JSON.parse(decoded) as T;
      } catch (err) {
        console.error(
          `Failed to parse JSON metadata "${key}" for user`,
          userId,
          err
        );
        return null;
      }
    } catch (e) {
      console.error(`Error while fetching metadata "${key}" for user`, userId, e);
      return null;
    }
  }

  private static async setUserJsonMetadata(
    userId: string,
    key: string,
    value: any,
    organizationId?: string
  ) {
    const url = `${UserService.base()}/management/v1/users/${encodeURIComponent(
      userId
    )}/metadata/_bulk`;

    let encoded: string;
    try {
      const json = JSON.stringify(value);
      encoded = UserService.encodeMetadataValue(json);
    } catch (e) {
      console.error(
        `Failed to stringify JSON metadata "${key}" for user`,
        userId,
        e
      );
      throw e;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({
        metadata: [
          {
            key,
            value: encoded
          }
        ]
      })
    });

    return UserService.parseOrThrow(res);
  }

  // ---------- request-scoped caches ----------
  /**
   * Per-request cache for project roles, keyed by "<orgId>:<projectId>" or "<projectId>".
   * Uses `getContext() as any` so TS doesn't complain about custom keys.
   */
  private static getProjectRoleCaches() {
    const ctx = getContext() as any;

    let roleCache = ctx.get("projectRoleCache") as
      | Map<string, ProjectRole[]>
      | undefined;
    if (!roleCache) {
      roleCache = new Map<string, ProjectRole[]>();
      ctx.set("projectRoleCache", roleCache);
    }

    let inflight = ctx.get("projectRoleInflight") as
      | Map<string, Promise<ProjectRole[]>>
      | undefined;
    if (!inflight) {
      inflight = new Map<string, Promise<ProjectRole[]>>();
      ctx.set("projectRoleInflight", inflight);
    }

    return { roleCache, inflight };
  }

  /**
   * Per-request cache for enriched Zitadel users, keyed by "<orgId>:<userId>" or "<userId>".
   * Uses `getContext() as any` so TS doesn't complain about custom keys.
   */
  private static getUserCaches() {
    const ctx = getContext() as any;

    let cache = ctx.get("zitadelUserCache") as
      | Map<string, ZitadelUser>
      | undefined;
    if (!cache) {
      cache = new Map<string, ZitadelUser>();
      ctx.set("zitadelUserCache", cache);
    }

    let inflight = ctx.get("zitadelUserInflight") as
      | Map<string, Promise<ZitadelUser>>
      | undefined;
    if (!inflight) {
      inflight = new Map<string, Promise<ZitadelUser>>();
      ctx.set("zitadelUserInflight", inflight);
    }

    return { cache, inflight };
  }

  // ---------- uniqueness ----------
  static async getIsUnique(loginName: string): Promise<boolean | null> {
    const env: any = UserService.env();
    let url = "";

    try {
      if (validator.isEmail(loginName) === true) {
        url = `${env?.AUTH_ISSUER}/management/v1/users/_is_unique?email=${encodeURIComponent(
          loginName
        )}`;
      } else if (validator.isAlphanumeric(loginName) === true) {
        url = `${env?.AUTH_ISSUER}/management/v1/users/_is_unique?userName=${encodeURIComponent(
          loginName
        )}`;
      }

      if (!url) {
        throw new InvalidInputError("Invalid email/username format");
      }

      const response: Response = await fetch(url, {
        method: "GET",
        headers: UserService.headers()
      });

      const data = (await response.json().catch(() => ({}))) as any;

      if (!response.ok) {
        throw new InvalidInputError(data?.message || "Something has gone Wrong");
      }

      return data?.isUnique ? true : false;
    } catch (e) {
      console.error(e);
      handleUserServiceError(e);
      throw e;
    }
  }

  // ---------- create (existing) ----------
  static async userCreate(
    values: {
      emailAddress: string;
      username: string;
      password?: string;
      hashedPassword?: string;
      details?: {
        firstName?: string;
        lastName?: string;
      };
    },
    organizationId?: string,
    createProfile?: boolean,
    skipEmailVerification?: boolean
  ): Promise<UserCreateResponse> {
    const env: any = UserService.env();
    const emailAddress = values.emailAddress.toLowerCase();
    const username = values.username.toLowerCase();

    const url = `${env?.AUTH_ISSUER}/management/v1/users/human/_import`;

    try {
      if (
        !(await UserService.getIsUnique(username)) ||
        !(await UserService.getIsUnique(emailAddress))
      ) {
        throw new EmailOrUsernameAlreadyExistsError(`${username} <${emailAddress}>`);
      }

      const response: Response = await fetch(url, {
        method: "POST",
        headers: UserService.headers(organizationId),
        body: JSON.stringify({
          userName: values.username,
          profile: {
            firstName: values.details?.firstName ?? "",
            lastName: values.details?.lastName ?? "",
            preferredLanguage: "en"
          },
          ...(values.hashedPassword ? { hashedPassword: { value: values.hashedPassword } } : {}),
          email: {
            email: values.emailAddress,
            isEmailVerified: skipEmailVerification || false
          },
          ...(values.password
            ? {
                password: values.password,
                passwordChangeRequired: false
              }
            : {})
        })
      });

      const data = (await response.json().catch(() => ({}))) as UserCreateResponse;
      if (!response.ok) {
        throw new InvalidInputError(data?.details?.toString() || "Something has gone Wrong");
      }

      return data;
    } catch (e) {
      console.error(e);
      handleUserServiceError(e);
      throw e;
    }
  }

  // --------------------------------------------------
  // READ HELPERS
  // --------------------------------------------------

  /**
   * List all project roles for a given project (v2 ProjectService).
   * We only expose key + displayName (no group/description).
   *
   * Uses a per-request cache so we only call this once per projectId (+orgId).
   */
  static async listProjectRoles(
    projectId: string,
    limit = 100,
    organizationId?: string
  ): Promise<ProjectRole[]> {
    const { roleCache, inflight } = UserService.getProjectRoleCaches();
    const cacheKey = organizationId ? `${organizationId}:${projectId}` : projectId;

    const cached = roleCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const existingPromise = inflight.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const url = `${UserService.base()}/zitadel.project.v2.ProjectService/ListProjectRoles`;

    const promise = (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: UserService.headers(organizationId),
          body: JSON.stringify({
            projectId,
            pagination: {
              offset: 0,
              limit
            }
          })
        });

        const data = (await res.json().catch(() => ({}))) as any;

        if (!res.ok) {
          console.error(
            "Failed to fetch project roles for project",
            projectId,
            "-",
            data?.message ?? `HTTP ${res.status}`
          );
          const empty: ProjectRole[] = [];
          roleCache.set(cacheKey, empty);
          return empty;
        }

        const rolesRaw = (data.projectRoles ?? data.result ?? []) as any[];

        const roles: ProjectRole[] = rolesRaw
          .map((r) => ({
            key: r.roleKey ?? r.key ?? "",
            displayName: r.displayName
          }))
          .filter((r) => r.key);

        roleCache.set(cacheKey, roles);
        return roles;
      } catch (err) {
        console.error(
          "Failed to fetch project roles for project",
          projectId,
          err
        );
        const empty: ProjectRole[] = [];
        roleCache.set(cacheKey, empty);
        return empty;
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    inflight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Internal helper: fetches all grants (with role objects) for a user by searching
   * user grants via management API: POST /management/v1/users/grants/_search
   * and returns them as ZitadelUserGrant[].
   *
   * We enrich each grant.roles with displayName by looking up project roles.
   * Project roles are cached per-request in listProjectRoles.
   */
  static async getUserRoleGrants(
    userId: string,
    organizationId?: string
  ): Promise<ZitadelUserGrant[]> {
    const url = `${UserService.base()}/management/v1/users/grants/_search`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: UserService.headers(organizationId),
        body: JSON.stringify({
          query: {
            offset: "0",
            limit: 100,
            asc: true
          },
          queries: [
            {
              user_id_query: {
                user_id: userId
              }
            }
          ]
        })
      });

      const data = (await res.json().catch(() => ({}))) as any;

      if (!res.ok) {
        console.error(
          "Failed to fetch user grants for user",
          userId,
          "-",
          data?.message ?? `HTTP ${res.status}`
        );
        return [];
      }

      const results: any[] = Array.isArray(data.result) ? data.result : [];
      const grants: ZitadelUserGrant[] = [];

      for (const g of results) {
        const details = g.details ?? {};

        const roleKeys: string[] = Array.isArray(g.roleKeys)
          ? g.roleKeys.filter((r: any) => typeof r === "string")
          : Array.isArray(g.roles)
            ? g.roles.filter((r: any) => typeof r === "string")
            : [];

        let roles: ProjectRole[] = [];

        if (roleKeys.length && g.projectId) {
          let projectRoles: ProjectRole[] = [];
          try {
            projectRoles = await UserService.listProjectRoles(
              g.projectId as string,
              200,
              organizationId
            );
          } catch (err) {
            // listProjectRoles itself already logs & caches empty on error
            console.error(
              "Failed to resolve project roles for grant project",
              g.projectId,
              err
            );
            projectRoles = [];
          }

          roles = roleKeys.map((key) => {
            const match = projectRoles?.find((r) => r.key === key);
            return {
              key,
              displayName: match?.displayName
            };
          });
        } else {
          // No projectId or we couldn't fetch project roles: fall back to key-only roles
          roles = roleKeys.map((key) => ({ key }));
        }

        const grant: ZitadelUserGrant = {
          organizationId: g.organizationId ?? g.orgId ?? undefined,
          creationDate: details.creationDate,
          changeDate: details.changeDate,
          projectId: g.projectId,
          projectName: g.projectName,
          state: g.state,
          roles
        };

        grants.push(grant);
      }

      return grants;
    } catch (e) {
      console.error("Error while fetching user grants for user", userId, e);
      return [];
    }
  }

  /**
   * Backwards-compatible helper: flatten all granted role keys of a user into
   * a unique string[] from the grant.role objects.
   */
  static async getUserRoleKeys(
    userId: string,
    organizationId?: string
  ): Promise<string[]> {
    const grants = await UserService.getUserRoleGrants(userId, organizationId);
    const keys = new Set<string>();

    for (const g of grants) {
      for (const r of g.roles ?? []) {
        if (typeof r.key === "string" && r.key.length > 0) {
          keys.add(r.key);
        }
      }
    }

    return Array.from(keys);
  }

  /**
   * Internal helper: best-effort fetch of avatar URL via user service v2.
   * If anything fails, it just returns undefined.
   */
  private static async fetchAvatarUrl(
    userId: string,
    organizationId?: string
  ): Promise<string | undefined> {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: UserService.headers(organizationId)
      });

      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        console.error(
          "Failed to fetch avatar for user",
          userId,
          "-",
          data?.message ?? `HTTP ${res.status}`
        );
        return undefined;
      }

      const u = data.user ?? data;

      const avatarUrl =
        (typeof u?.avatarUrl === "string" && u.avatarUrl) ||
        (typeof u?.profile?.avatarUrl === "string" && u.profile.avatarUrl) ||
        (typeof u?.human?.profile?.avatarUrl === "string" && u.human.profile.avatarUrl) ||
        undefined;

      return avatarUrl;
    } catch (e) {
      console.error("Error while fetching avatar for user", userId, e);
      return undefined;
    }
  }

  /**
   * Internal helper: fetch revenue from user metadata key "revenue".
   * Uses generic numeric metadata helper.
   */
  private static async getUserRevenue(
    userId: string,
    organizationId?: string
  ): Promise<number | null> {
    return UserService.getUserNumericMetadata(userId, "revenue", organizationId);
  }

  /**
   * Helper: builds a "lazy" ZitadelUser where heavy fields are anonymous
   * functions that will only run if requested in the GraphQL query.
   */
  private static buildLazyZitadelUser(
    user: ZitadelUser,
    organizationId?: string
  ): ZitadelUser {
    const id = user.id;

    let grantsPromise: Promise<ZitadelUserGrant[]> | null = null;
    const getGrantsLazy = () => {
      if (!grantsPromise) {
        grantsPromise = UserService.getUserRoleGrants(id, organizationId);
      }
      return grantsPromise;
    };

    let avatarPromise: Promise<string | undefined> | null = null;
    const getAvatarLazy = () => {
      if (!avatarPromise) {
        avatarPromise = UserService.fetchAvatarUrl(id, organizationId);
      }
      return avatarPromise;
    };

    let revenuePromise: Promise<number | null> | null = null;
    const getRevenueLazy = () => {
      if (!revenuePromise) {
        revenuePromise = UserService.getUserRevenue(id, organizationId);
      }
      return revenuePromise;
    };

    let transferCountPromise: Promise<number | null> | null = null;
    const getTransferCountLazy = () => {
      if (!transferCountPromise) {
        transferCountPromise = UserService.getUserNumericMetadata(
          id,
          "transferCount",
          organizationId
        );
      }
      return transferCountPromise;
    };

    let monthlyRevenuePromise: Promise<number | null> | null = null;
    const getMonthlyRevenueLazy = () => {
      if (!monthlyRevenuePromise) {
        monthlyRevenuePromise = UserService.getUserNumericMetadata(
          id,
          "monthlyRevenue",
          organizationId
        );
      }
      return monthlyRevenuePromise;
    };

    let monthlyCountPromise: Promise<number | null> | null = null;
    const getMonthlyCountLazy = () => {
      if (!monthlyCountPromise) {
        monthlyCountPromise = UserService.getUserNumericMetadata(
          id,
          "monthlyCount",
          organizationId
        );
      }
      return monthlyCountPromise;
    };

    let routesPromise: Promise<UserRoute[] | null> | null = null;
    const getRoutesLazy = () => {
      if (!routesPromise) {
        routesPromise = UserService.getUserRoutes(id, organizationId);
      }
      return routesPromise;
    };

    const enriched: any = {
      ...user,

      // Lazily resolve grants
      grants: () => getGrantsLazy(),

      // Lazily resolve roles, derived from grants
      roles: async () => {
        const grants = await getGrantsLazy();
        const aggregatedRoleMap = new Map<string, ProjectRole>();
        for (const g of grants) {
          for (const r of g.roles ?? []) {
            if (!r?.key) continue;
            const existing = aggregatedRoleMap.get(r.key);
            if (!existing || (!existing.displayName && r.displayName)) {
              aggregatedRoleMap.set(r.key, {
                key: r.key,
                displayName: r.displayName
              });
            }
          }
        }
        return Array.from(aggregatedRoleMap.values());
      },

      // Lazy avatar
      avatarUrl: () => getAvatarLazy(),

      // Lazy metadata numbers
      revenue: () => getRevenueLazy(),
      transferCount: () => getTransferCountLazy(),
      monthlyRevenue: () => getMonthlyRevenueLazy(),
      monthlyCount: () => getMonthlyCountLazy(),

      // Lazy JSON routes metadata
      routes: () => getRoutesLazy()
    };

    return enriched as ZitadelUser;
  }

  static async getZitadelUserById(
    userId: string,
    organizationId?: string
  ): Promise<ZitadelUser> {
    const { cache, inflight } = UserService.getUserCaches();
    const cacheKey = organizationId ? `${organizationId}:${userId}` : userId;

    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const existingPromise = inflight.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = (async () => {
      const url = `${UserService.base()}/management/v1/users/${encodeURIComponent(userId)}`;

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: UserService.headers(organizationId)
        });

        const data = (await response.json().catch(() => ({}))) as any;

        if (!response.ok) {
          if (response.status === 404) {
            throw new UserNotFoundError(userId);
          }
          throw new InvalidInputError(data?.message || "Something has gone Wrong");
        }

        const user = (data?.user ?? data) as ZitadelUser;

        if (!user?.id) {
          throw new InvalidInputError("Malformed user payload");
        }

        const enriched = UserService.buildLazyZitadelUser(user, organizationId);
        cache.set(cacheKey, enriched);
        return enriched;
      } catch (e) {
        console.error(e);
        handleUserServiceError(e);
        throw e;
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    inflight.set(cacheKey, promise);
    return promise;
  }

  static async listAllZitadelUsers(
    limit = 100,
    organizationId?: string
  ): Promise<ZitadelUser[]> {
    const url = `${UserService.base()}/management/v1/users/_search`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: UserService.headers(organizationId),
        body: JSON.stringify({
          limit,
          offset: 0
        })
      });

      const payload = (await response.json().catch(() => ({}))) as any;

      if (!response.ok) {
        throw new InvalidInputError(payload?.message || "Something has gone Wrong");
      }

      const data = payload as GetAllUsersResponse;
      const users = data.result ?? [];

      const { cache } = UserService.getUserCaches();

      const enriched = users.map((user) => {
        if (!user?.id) return user as ZitadelUser;
        const cacheKey = organizationId ? `${organizationId}:${user.id}` : user.id;
        let existing = cache.get(cacheKey);
        if (!existing) {
          existing = UserService.buildLazyZitadelUser(user, organizationId);
          cache.set(cacheKey, existing);
        }
        return existing;
      });

      return enriched;
    } catch (e) {
      console.error(e);
      handleUserServiceError(e);
      throw e;
    }
  }

  static async getUserCount(): Promise<number> {
    const url = `${UserService.base()}/management/v1/users/_search`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: UserService.headers(),
        body: JSON.stringify({
          limit: 1,
          offset: 0
        })
      });

      const payload = (await response.json().catch(() => ({}))) as any;

      if (!response.ok) {
        throw new InvalidInputError(payload?.message || "Something has gone Wrong");
      }

      const data = payload as GetAllUsersResponse;

      return parseInt(data.details.totalResult) || 0;
    } catch (e) {
      console.error(e);
      handleUserServiceError(e);
      throw e;
    }
  }

  /**
   * NEW: Return all users that have the given role key.
   * Uses listAllZitadelUsers + lazy grants resolver.
   */
  static async listUsersByRole(
    roleKey: string,
    limit = 100,
    organizationId?: string
  ): Promise<ZitadelUser[]> {
    const allUsers = await UserService.listAllZitadelUsers(limit, organizationId);
    const matches: ZitadelUser[] = [];

    for (const u of allUsers) {
      try {
        const rawGrants = (u as any).grants;
        let grants: ZitadelUserGrant[] = [];

        if (Array.isArray(rawGrants)) {
          grants = rawGrants;
        } else if (typeof rawGrants === "function") {
          grants = await rawGrants();
        }

        const hasRole = grants.some((g) =>
          (g.roles ?? []).some((r) => r.key === roleKey)
        );

        if (hasRole) {
          matches.push(u);
        }
      } catch (err) {
        console.error(
          "Failed to resolve grants while filtering by role for user",
          (u as any)?.id,
          err
        );
      }
    }

    return matches;
  }

  // --------------------------------------------------
  // NEW: Project role management (add/remove)
  // --------------------------------------------------

  /**
   * Add a project role (v2 ProjectService.AddProjectRole).
   * Only key + optional displayName.
   */
  static async addProjectRole(
    projectId: string,
    roleKey: string,
    displayName?: string,
    organizationId?: string
  ) {
    const url = `${UserService.base()}/zitadel.project.v2.ProjectService/AddProjectRole`;

    const body: any = {
      projectId,
      roleKey
    };
    if (displayName) body.displayName = displayName;

    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify(body)
    });

    return UserService.parseOrThrow(res);
  }

  /**
   * Remove a project role (v2 ProjectService.RemoveProjectRole).
   */
  static async removeProjectRole(
    projectId: string,
    roleKey: string,
    organizationId?: string
  ) {
    const url = `${UserService.base()}/zitadel.project.v2.ProjectService/RemoveProjectRole`;

    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({
        projectId,
        roleKey
      })
    });

    return UserService.parseOrThrow(res);
  }

  // --------------------------------------------------
  // NEW: User lifecycle (delete, deactivate/reactivate, lock/unlock)
  // --------------------------------------------------
  static async deleteUser(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: UserService.headers(organizationId)
    });
    return UserService.parseOrThrow(res);
  }

  static async deactivateUser(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/deactivate`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({})
    });
    return UserService.parseOrThrow(res);
  }

  static async reactivateUser(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/reactivate`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({})
    });
    return UserService.parseOrThrow(res);
  }

  static async lockUser(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/lock`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({})
    });
    return UserService.parseOrThrow(res);
  }

  static async unlockUser(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/unlock`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({})
    });
    return UserService.parseOrThrow(res);
  }

  // --------------------------------------------------
  // NEW: User partial update (username/profile/email/phone/password)
  // --------------------------------------------------
  static async updateUser(
    userId: string,
    changes: UserUpdateInput,
    organizationId?: string
  ) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}`;

    const payload: any = {};
    if (changes.username) payload.username = changes.username;
    if (changes.profile) payload.profile = { ...changes.profile };
    if (changes.email) payload.email = { ...changes.email };
    if (changes.phone) payload.phone = { ...changes.phone };
    if (changes.password) {
      payload.newPassword = {
        password: changes.password.password,
        changeRequired: !!changes.password.changeRequired
      };
    }

    const res = await fetch(url, {
      method: "PATCH",
      headers: UserService.headers(organizationId),
      body: JSON.stringify(payload)
    });

    return UserService.parseOrThrow(res);
  }

  // --------------------------------------------------
  // NEW: Credentials & verification flows
  // --------------------------------------------------

  static async setPassword(
    userId: string,
    newPassword: string,
    changeRequired = false,
    organizationId?: string
  ) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/password`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({
        newPassword: {
          password: newPassword,
          changeRequired
        }
      })
    });
    return UserService.parseOrThrow(res);
  }

  static async requestPasswordReset(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/password_reset`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({})
    });
    return UserService.parseOrThrow(res);
  }

  static async sendEmailVerification(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/email/send`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({})
    });
    return UserService.parseOrThrow(res);
  }

  static async resendEmailVerification(userId: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/email/resend`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({})
    });
    return UserService.parseOrThrow(res);
  }

  static async verifyEmail(userId: string, code: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/email/verify`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({ code })
    });
    return UserService.parseOrThrow(res);
  }

  static async setPhone(userId: string, phone: string, organizationId?: string) {
    const url = `${UserService.base()}/v2/users/${encodeURIComponent(userId)}/phone`;
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify({ phone })
    });
    return UserService.parseOrThrow(res);
  }

  // --------------------------------------------------
  // NEW: Role / Authorization management (assign roles to user on a project)
  // --------------------------------------------------

  static async createAuthorization(input: AuthorizationCreateInput, organizationId?: string) {
    const url = `${UserService.base()}/zitadel.authorization.v2.AuthorizationService/CreateAuthorization`;
    const body = {
      userId: input.userId,
      roleKeys: input.roleKeys,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.projectGrantId ? { projectGrantId: input.projectGrantId } : {})
    };

    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify(body)
    });
    return UserService.parseOrThrow(res);
  }

  static async updateAuthorization(input: AuthorizationUpdateInput, organizationId?: string) {
    const url = `${UserService.base()}/zitadel.authorization.v2.AuthorizationService/UpdateAuthorization`;
    const body = {
      authorizationId: input.authorizationId,
      roleKeys: input.roleKeys
    };

    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify(body)
    });
    return UserService.parseOrThrow(res);
  }

  static async deleteAuthorization(authorizationId: string, organizationId?: string) {
    const url = `${UserService.base()}/zitadel.authorization.v2.AuthorizationService/DeleteAuthorization`;
    const body = { authorizationId };
    const res = await fetch(url, {
      method: "POST",
      headers: UserService.headers(organizationId),
      body: JSON.stringify(body)
    });
    return UserService.parseOrThrow(res);
  }

  // --------------------------------------------------
  // NEW: Revenue & counters metadata management
  // --------------------------------------------------

  /**
   * Set revenue for a user (stored as metadata key "revenue").
   */
  static async setUserRevenue(
    userId: string,
    revenue: number,
    organizationId?: string
  ) {
    return UserService.setUserNumericMetadata(userId, "revenue", revenue, organizationId);
  }

  static async setUserTransferCount(
    userId: string,
    transferCount: number,
    organizationId?: string
  ) {
    return UserService.setUserNumericMetadata(
      userId,
      "transferCount",
      transferCount,
      organizationId
    );
  }

  static async setUserMonthlyRevenue(
    userId: string,
    monthlyRevenue: number,
    organizationId?: string
  ) {
    return UserService.setUserNumericMetadata(
      userId,
      "monthlyRevenue",
      monthlyRevenue,
      organizationId
    );
  }

  static async setUserMonthlyCount(
    userId: string,
    monthlyCount: number,
    organizationId?: string
  ) {
    return UserService.setUserNumericMetadata(
      userId,
      "monthlyCount",
      monthlyCount,
      organizationId
    );
  }

  // --------------------------------------------------
  // NEW: Routes metadata management (JSON list of route objects)
  // --------------------------------------------------

  static async getUserRoutes(
    userId: string,
    organizationId?: string
  ): Promise<UserRoute[] | null> {
    return UserService.getUserJsonMetadata<UserRoute[]>(userId, "routes", organizationId);
  }

  static async setUserRoutes(
    userId: string,
    routes: UserRoute[],
    organizationId?: string
  ) {
    return UserService.setUserJsonMetadata(userId, "routes", routes, organizationId);
  }
}

function handleUserServiceError(e: unknown) {
  // Adjust error handling logic as needed
  throw e;
}
