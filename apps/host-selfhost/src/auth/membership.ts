import { NoOrganization, Unavailable } from "@executor-js/api/server";
import { Data, Effect } from "effect";

import { isPrivileged } from "../admin/require-admin";
import type { BetterAuthHandle } from "./better-auth";

export type InstanceOrgRole = "admin" | "member";

export interface InstanceMembership {
  /** Workspace-write authority, from the row's role (`owner`/`admin` -> admin). */
  readonly role: InstanceOrgRole;
}

export class MembershipLookupFailed extends Data.TaggedError("MembershipLookupFailed")<{
  readonly cause: unknown;
}> {}

/** Returns null only when the caller has no membership row. */
export const findInstanceMembership = (
  betterAuth: BetterAuthHandle,
  userId: string,
  organizationId: string,
): Effect.Effect<InstanceMembership | null, MembershipLookupFailed> =>
  Effect.tryPromise({
    try: async () => {
      const context = await betterAuth.auth.$context;
      return context.adapter.findOne<{ readonly role?: string | null }>({
        model: "member",
        where: [
          { field: "userId", value: userId },
          { field: "organizationId", value: organizationId },
        ],
      });
    },
    catch: (cause) => new MembershipLookupFailed({ cause }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.map((row): InstanceMembership | null =>
      row ? { role: row.role != null && isPrivileged(row.role) ? "admin" : "member" } : null,
    ),
    Effect.withSpan("selfhost.identity.membership"),
  );

export const requireInstanceMembership = (
  betterAuth: BetterAuthHandle,
  userId: string,
  organizationId: string,
): Effect.Effect<InstanceOrgRole, NoOrganization | Unavailable> =>
  findInstanceMembership(betterAuth, userId, organizationId).pipe(
    Effect.mapError(() => new Unavailable({ message: "Membership lookup unavailable" })),
    Effect.flatMap((membership) =>
      membership ? Effect.succeed(membership.role) : Effect.fail(new NoOrganization()),
    ),
  );
