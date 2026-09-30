import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  addGroupMembersRequestSchema,
  approveJoinRequestSchema,
  createGroupRequestSchema,
  cursorQuerySchema,
  discoverGroupsQuerySchema,
  groupMemberRefSchema,
  joinByCodeRequestSchema,
  removeGroupMemberRequestSchema,
  updateGroupRequestSchema,
} from "@convo/shared";
import type { AppDeps } from "../deps.js";
import { unauthorized } from "../lib/errors.js";
import { parse } from "../lib/validation.js";
import { authenticatePreHandler } from "../plugins/auth.js";
import {
  addGroupMembers,
  applyToJoin,
  approveJoinRequest,
  createGroup,
  deleteGroup,
  discoverPublicGroups,
  getGroup,
  joinByCode,
  leaveGroup,
  listGroups,
  rejectJoinRequest,
  removeGroupMember,
  revokeInviteLink,
  setMemberRole,
  updateGroup,
  type GroupDeps,
} from "../services/groups.js";
import { mediaDownloadUrl } from "./media.js";

/**
 * Group chat API (Phase 4B). Membership is checked in the service layer;
 * non-members may only preview PUBLIC groups (invite link / discovery).
 */
export async function groupRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.addHook("preHandler", authenticatePreHandler(deps.db));
  const svc: GroupDeps = {
    db: deps.db,
    hub: deps.hub,
    mediaUrl: (key) => mediaDownloadUrl(app, deps, key),
  };

  app.post(
    "/groups",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const body = parse(createGroupRequestSchema, request.body);
      return createGroup(svc, requireUserId(request), body);
    },
  );

  app.get("/groups", async (request) => {
    const q = parse(cursorQuerySchema, request.query);
    return listGroups(svc, requireUserId(request), q);
  });

  app.get("/groups/discover", async (request) => {
    const q = parse(discoverGroupsQuerySchema, request.query);
    return { groups: await discoverPublicGroups(svc, requireUserId(request), q) };
  });

  app.get("/groups/join/:code", async (request) => {
    const { code } = request.params as { code: string };
    return joinByCode(svc, requireUserId(request), code);
  });

  app.get("/groups/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getGroup(svc, requireUserId(request), id);
  });

  app.patch("/groups/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(updateGroupRequestSchema, request.body);
    return updateGroup(svc, requireUserId(request), id, body);
  });

  app.delete("/groups/:id", async (request) => {
    const { id } = request.params as { id: string };
    return deleteGroup(svc, requireUserId(request), id);
  });

  app.post(
    "/groups/:id/members",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parse(addGroupMembersRequestSchema, request.body);
      return addGroupMembers(svc, requireUserId(request), id, body);
    },
  );

  app.delete("/groups/:id/members", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(removeGroupMemberRequestSchema, request.body);
    return removeGroupMember(svc, requireUserId(request), id, body);
  });

  app.post("/groups/:id/leave", async (request) => {
    const { id } = request.params as { id: string };
    return leaveGroup(svc, requireUserId(request), id);
  });

  app.put("/groups/:id/admins", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(groupMemberRefSchema, request.body);
    return setMemberRole(svc, requireUserId(request), id, body.userId, "ADMIN");
  });

  app.delete("/groups/:id/admins", async (request) => {
    const { id } = request.params as { id: string };
    const { userId } = parse(groupMemberRefSchema, request.query);
    return setMemberRole(svc, requireUserId(request), id, userId, "MEMBER");
  });

  app.get("/groups/:id/requests", async (request) => {
    const { id } = request.params as { id: string };
    const detail = await getGroup(svc, requireUserId(request), id);
    return { requests: detail.joinRequests };
  });

  app.post("/groups/:id/requests/approve", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(approveJoinRequestSchema, request.body);
    return approveJoinRequest(svc, requireUserId(request), id, body.userId);
  });

  app.post("/groups/:id/requests/reject", async (request) => {
    const { id } = request.params as { id: string };
    const body = parse(approveJoinRequestSchema, request.body);
    return rejectJoinRequest(svc, requireUserId(request), id, body.userId);
  });

  app.post(
    "/groups/:id/apply",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = request.params as { id: string };
      return applyToJoin(svc, requireUserId(request), id);
    },
  );

  app.post("/groups/:id/invite/revoke", async (request) => {
    const { id } = request.params as { id: string };
    return revokeInviteLink(svc, requireUserId(request), id);
  });
}

function requireUserId(request: FastifyRequest): string {
  if (!request.currentUser) throw unauthorized();
  return request.currentUser.id;
}
