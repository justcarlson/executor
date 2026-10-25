import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";
import { Api, Target } from "../../src/services";
import { createInvitedIdentity } from "../../targets/selfhost";

export const freshForkIdentity = Effect.gen(function* () {
  const target = yield* Target;
  const admin = yield* target.newIdentity();
  const { client } = yield* Api;
  const account = yield* client(AccountHttpApi, admin);
  const identity = yield* Effect.promise(() =>
    createInvitedIdentity(target.baseUrl, admin, { role: "admin", emailPrefix: "fork-e2e" }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const { members } = yield* account.account.listMembers();
      const member = members.find((candidate) => candidate.email === identity.label);
      if (!member)
        return yield* Effect.die(`Fresh member not found during cleanup: ${identity.label}`);
      yield* account.account.removeMember({ params: { membershipId: member.id } });
    }).pipe(Effect.orDie),
  );
  return identity;
});
