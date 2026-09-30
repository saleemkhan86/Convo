import type { Prisma } from "@prisma/client";
import type {
  AddGroupMembersRequest,
  CreateGroupRequest,
  DiscoverGroupsQuery,
  GroupAddVisibility,
  GroupDetail,
  GroupMember,
  GroupSettings,
  GroupSummary,
  RemoveGroupMemberRequest,
  UpdateGroupRequest,
} from "@convo/shared";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { messageInclude, serializeMessage, type ConversationDeps } from "./conversations.js";
import { mayAddToGroup } from "./privacy.js";

/**
 * Group chats (Phase 4B), WhatsApp-style:
 * - PRIVATE groups: entry requires an admin invite or approval of a join
 *   request (ConversationMember.joinState = PENDING until an admin decides).
 * - PUBLIC groups: anyone with the invite link can join directly; the group
 *   is findable by name.
 * Settings per group: who can send, who can edit, announce-only, approval
 * requirement. Admin actions: add/remove members, promote/demote, resolve
 * join requests, edit settings, revoke the invite link.
 */

export interface GroupDeps extends ConversationDeps {}

const GROUP_MEMBER_CAP = 1024;

type MemberRow = Prisma.ConversationMemberGetPayload<{
  include: { user: { include: { phoneIdentity: true } } };
}>;

export type ConversationWithGroup = Prisma.ConversationGetPayload<{
  include: { group: true; members: true };
}>;

const memberInclude = { user: { include: { phoneIdentity: true } } } as const;

function toMember(m: MemberRow): GroupMember {
  return {
    userId: m.userId,
    displayName: m.user.displayName,
    avatarUrl: m.user.avatarUrl,
    phone: m.user.phoneIdentity?.phone ?? null,
    role: m.role,
    joinState: m.joinState === "PENDING" ? "PENDING" : "ACTIVE",
    joinedAt: m.leftAt ? null : m.joinedAt.toISOString(),
  };
}

async function requireActiveMembership(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
): Promise<MemberRow> {
  const member = await deps.db.conversationMember.findFirst({
    where: { userId, conversationId, leftAt: null, joinState: "ACTIVE" },
    include: memberInclude,
  });
  if (!member) throw notFound("Group not found");
  return member;
}

async function requireGroup(
  deps: GroupDeps,
  conversationId: string,
): Promise<ConversationWithGroup> {
  const conversation = await deps.db.conversation.findFirst({
    where: { id: conversationId, type: "GROUP" },
    include: { group: true, members: true },
  });
  if (!conversation?.group) throw notFound("Group not found");
  return conversation;
}

async function requireAdmin(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
): Promise<MemberRow> {
  const member = await requireActiveMembership(deps, userId, conversationId);
  if (member.role !== "ADMIN") {
    throw forbidden("Only group admins can do that");
  }
  return member;
}

async function activeMemberCount(db: GroupDeps["db"], conversationId: string): Promise<number> {
  return db.conversationMember.count({ where: { conversationId, leftAt: null, joinState: "ACTIVE" } });
}

function settingsOf(profile: NonNullable<ConversationWithGroup["group"]>): GroupSettings {
  return {
    visibility: profile.visibility,
    whoCanSend: profile.whoCanSend,
    whoCanEdit: profile.whoCanEdit,
    whoCanInvite: profile.whoCanInvite,
    announceOnly: profile.announceOnly,
    requireApproval: profile.requireApproval,
  };
}

/**
 * Group icon (5E): an uploaded group's avatar is a media key, so each read
 * signs a fresh short-lived URL for it. Falls back to the plain `avatarUrl`
 * string a group created before 5E may still carry.
 */
function avatarOf(
  conv: ConversationWithGroup,
  mediaUrl: ConversationDeps["mediaUrl"],
): string | null {
  const key = conv.group?.avatarStorageKey;
  return key ? mediaUrl(key) : conv.avatarUrl;
}

export function summaryOf(
  conv: ConversationWithGroup,
  viewerRole: "ADMIN" | "MEMBER" | null,
  includeInvite: boolean,
  mediaUrl: ConversationDeps["mediaUrl"],
): GroupSummary {
  const profile = conv.group!;
  return {
    conversationId: conv.id,
    name: conv.title ?? "Group",
    avatarUrl: avatarOf(conv, mediaUrl),
    about: profile.about,
    memberCount: conv.members.filter((m) => m.leftAt === null && m.joinState === "ACTIVE").length,
    settings: settingsOf(profile),
    myRole: viewerRole,
    inviteCode: includeInvite ? profile.inviteCode : null,
    createdAt: conv.createdAt.toISOString(),
  };
}

/** Who may see and share the invite link (5E): everyone, or admins only. */
export function mayInvite(role: GroupSummary["myRole"], profile: GroupSettings): boolean {
  if (role === null) return false;
  return profile.whoCanInvite === "ADMINS" ? role === "ADMIN" : true;
}

/** Publish an event to every active member of the group. */
async function publishToGroup(
  deps: GroupDeps,
  conversationId: string,
  event: Parameters<ConversationDeps["hub"]["publishToUsers"]>[1],
  excludeUserId?: string,
): Promise<void> {
  const members = await deps.db.conversationMember.findMany({
    where: { conversationId, leftAt: null, joinState: "ACTIVE", ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
    select: { userId: true },
  });
  deps.hub.publishToUsers(
    members.map((m) => m.userId),
    event,
  );
}

/** Grey centered system line in the timeline ("X added Y"). */
async function postSystemMessage(
  deps: GroupDeps,
  conversationId: string,
  body: string,
): Promise<void> {
  // Serialized with an empty viewer id: a system line has no per-viewer state,
  // so the one payload is identical for every member.
  const message = await deps.db.message.create({
    data: { conversationId, senderId: null, type: "SYSTEM", body },
    include: messageInclude,
  });
  await deps.db.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: message.createdAt },
  });
  await publishToGroup(deps, conversationId, {
    type: "message.new",
    message: serializeMessage(message, "", deps.mediaUrl),
  });
}

// ────────────────────────────── create ──────────────────────────────

/**
 * A group icon is an uploaded media object, so the key must belong to the
 * person setting it — otherwise anyone could point a group at someone else's
 * media and read it through the group's signed URLs (5E).
 */
async function assertOwnsMedia(db: GroupDeps["db"], userId: string, storageKey: string): Promise<void> {
  const owned = await db.mediaObject.findFirst({
    where: { ownerId: userId, storageKey },
    select: { id: true },
  });
  if (!owned) throw badRequest("Unknown media key for the group icon");
}

export async function createGroup(
  deps: GroupDeps,
  creatorId: string,
  req: CreateGroupRequest,
): Promise<GroupDetail> {
  const creator = await requirePhoneUser(deps.db, creatorId);
  const peers = await resolvePhones(deps.db, req.phones ?? [], creatorId);
  if (req.avatarStorageKey) await assertOwnsMedia(deps.db, creatorId, req.avatarStorageKey);

  const conv = await deps.db.conversation.create({
    data: {
      type: "GROUP",
      title: req.name,
      avatarUrl: req.avatarUrl ?? null,
      createdBy: creatorId,
      group: {
        create: {
          visibility: req.visibility,
          requireApproval: false,
          about: req.about ?? null,
          avatarStorageKey: req.avatarStorageKey ?? null,
        },
      },
      members: {
        create: [
          { userId: creatorId, role: "ADMIN" },
          ...peers.map((p) => ({ userId: p.id, role: "MEMBER" as const, invitedById: creatorId })),
        ],
      },
    },
    include: { group: true, members: true },
  });

  if (peers.length > 0) {
    await postSystemMessage(
      deps,
      conv.id,
      `${creator.displayName ?? "Someone"} created the group "${req.name}"`,
    );
  }
  return getGroup(deps, creatorId, conv.id);
}

// ────────────────────────────── read ──────────────────────────────

export async function listGroups(
  deps: GroupDeps,
  userId: string,
  opts: { cursor?: string; limit: number },
): Promise<{ groups: GroupSummary[]; nextCursor: string | null }> {
  const rows = await deps.db.conversationMember.findMany({
    where: {
      userId,
      leftAt: null,
      joinState: "ACTIVE",
      archived: false,
      conversation: { type: "GROUP", group: { isNot: null } },
    },
    include: { conversation: { include: { group: true, members: true } } },
    orderBy: [{ pinned: "desc" }, { conversation: { lastMessageAt: "desc" } }, { id: "asc" }],
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  return {
    groups: page.map((m) =>
      summaryOf(
        m.conversation,
        m.role,
        mayInvite(m.role, settingsOf(m.conversation.group!)),
        deps.mediaUrl,
      ),
    ),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

export async function getGroup(deps: GroupDeps, userId: string, conversationId: string): Promise<GroupDetail> {
  const conv = await requireGroup(deps, conversationId);
  const viewer = conv.members.find(
    (m) => m.userId === userId && m.leftAt === null && m.joinState === "ACTIVE",
  );

  if (!viewer) {
    // Non-members may preview a group (invite link / discovery); they only
    // ever see public metadata — never the roster.
    const profile = conv.group!;
    if (profile.visibility !== "PUBLIC") throw notFound("Group not found");
    return {
      ...summaryOf(conv, null, false, deps.mediaUrl),
      members: [],
      joinRequests: [],
    };
  }

  const activeMembers = await deps.db.conversationMember.findMany({
    where: { conversationId, leftAt: null, joinState: "ACTIVE" },
    include: memberInclude,
    orderBy: { joinedAt: "asc" },
  });
  const requests =
    viewer.role === "ADMIN"
      ? await deps.db.conversationMember.findMany({
          where: { conversationId, leftAt: null, joinState: "PENDING" },
          include: memberInclude,
          orderBy: { joinedAt: "asc" },
        })
      : [];

  return {
    ...summaryOf(
      conv,
      viewer.role,
      mayInvite(viewer.role, settingsOf(conv.group!)),
      deps.mediaUrl,
    ),
    members: activeMembers.map(toMember),
    joinRequests: requests.map(toMember),
  };
}

export async function discoverPublicGroups(
  deps: GroupDeps,
  userId: string,
  q: DiscoverGroupsQuery,
): Promise<GroupSummary[]> {
  const rows = await deps.db.conversation.findMany({
    where: {
      type: "GROUP",
      group: { visibility: "PUBLIC" },
      title: { contains: q.q, mode: "insensitive" },
    },
    include: { group: true, members: true },
    orderBy: { lastMessageAt: "desc" },
    take: q.limit,
  });
  return rows.map((conv) => {
    const viewer = conv.members.find(
      (m) => m.userId === userId && m.leftAt === null && m.joinState === "ACTIVE",
    );
    return summaryOf(conv, viewer?.role ?? null, false, deps.mediaUrl);
  });
}

// ────────────────────────────── settings ──────────────────────────────

export async function updateGroup(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
  req: UpdateGroupRequest,
): Promise<GroupDetail> {
  const conv = await requireGroup(deps, conversationId);
  const actor = await requireActiveMembership(deps, userId, conversationId);
  const canEditAll = actor.role === "ADMIN";
  const canEditInfo =
    canEditAll || conv.group!.whoCanEdit === "ALL";
  if (!canEditInfo) throw forbidden("Only admins can change group info");
  if (!canEditAll && req.settings) throw forbidden("Only admins can change group settings");
  if (req.avatarStorageKey) await assertOwnsMedia(deps.db, userId, req.avatarStorageKey);

  await deps.db.conversation.update({
    where: { id: conversationId },
    data: {
      ...(req.name !== undefined ? { title: req.name } : {}),
      ...(req.avatarUrl !== undefined ? { avatarUrl: req.avatarUrl } : {}),
    },
  });
  if (req.about !== undefined || req.settings || req.avatarStorageKey !== undefined) {
    await deps.db.groupProfile.update({
      where: { conversationId },
      data: {
        ...(req.about !== undefined ? { about: req.about } : {}),
        ...(req.avatarStorageKey !== undefined ? { avatarStorageKey: req.avatarStorageKey } : {}),
        ...(req.settings?.visibility !== undefined ? { visibility: req.settings.visibility } : {}),
        ...(req.settings?.whoCanSend !== undefined ? { whoCanSend: req.settings.whoCanSend } : {}),
        ...(req.settings?.whoCanEdit !== undefined ? { whoCanEdit: req.settings.whoCanEdit } : {}),
        ...(req.settings?.whoCanInvite !== undefined ? { whoCanInvite: req.settings.whoCanInvite } : {}),
        ...(req.settings?.announceOnly !== undefined ? { announceOnly: req.settings.announceOnly } : {}),
        ...(req.settings?.requireApproval !== undefined ? { requireApproval: req.settings.requireApproval } : {}),
      },
    });
  }
  publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  return getGroup(deps, userId, conversationId);
}

export async function revokeInviteLink(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
): Promise<GroupDetail> {
  await requireAdmin(deps, userId, conversationId);
  await deps.db.groupProfile.update({
    where: { conversationId },
    data: { inviteRevokedAt: new Date() },
  });
  publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  return getGroup(deps, userId, conversationId);
}

// ────────────────────────────── members ──────────────────────────────

export async function addGroupMembers(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
  req: AddGroupMembersRequest,
): Promise<GroupDetail> {
  const conv = await requireGroup(deps, conversationId);
  const actor = await requireActiveMembership(deps, userId, conversationId);
  // Private groups: only admins may add. Public groups: any member.
  if (conv.group!.visibility === "PRIVATE" && actor.role !== "ADMIN") {
    throw forbidden("Only admins can add people to a private group");
  }
  const peers = await resolvePhones(deps.db, req.phones, userId);
  // Who-can-add-me (5C): people who hide from group invites are silently
  // skipped — a "yes" answer would become a profile-privacy oracle.
  const addable: typeof peers = [];
  for (const peer of peers) {
    if (await mayAddToGroup(deps.db, userId, peer.id, peer)) addable.push(peer);
  }
  if (addable.length === 0) return getGroup(deps, userId, conversationId);

  const active = await activeMemberCount(deps.db, conversationId);
  if (active + addable.length > GROUP_MEMBER_CAP) {
    throw badRequest("This group is full");
  }

  const added: typeof peers = [];
  // Re-add escalation (5E): once a person has left a group, an ordinary member
  // may not put them straight back in — the re-add waits as a join request for
  // an admin. Admins keep the power to re-add directly.
  const escalated: string[] = [];
  for (const peer of addable) {
    const existing = await deps.db.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId, userId: peer.id } },
    });
    if (existing && existing.leftAt === null && existing.joinState === "ACTIVE") continue;
    const needsApproval = existing !== null && existing.leftAt !== null && actor.role !== "ADMIN";
    if (existing) {
      await deps.db.conversationMember.update({
        where: { id: existing.id },
        data: {
          leftAt: null,
          joinState: needsApproval ? "PENDING" : "ACTIVE",
          role: "MEMBER",
          invitedById: userId,
          ...(needsApproval ? {} : { joinedAt: new Date() }),
        },
      });
    } else {
      await deps.db.conversationMember.create({
        data: {
          conversationId,
          userId: peer.id,
          invitedById: userId,
        },
      });
    }
    if (needsApproval) {
      escalated.push(peer.id);
      continue;
    }
    added.push(peer);
  }

  if (escalated.length > 0) {
    const requests = await deps.db.conversationMember.findMany({
      where: { conversationId, userId: { in: escalated }, joinState: "PENDING" },
      include: memberInclude,
    });
    for (const request of requests) await notifyJoinRequest(deps, conv, request);
  }

  if (added.length > 0) {
    const names = added.map((p) => p.displayName ?? p.phone ?? "someone").join(", ");
    await postSystemMessage(deps, conversationId, `${actor.user.displayName ?? "An admin"} added ${names}`);
    for (const peer of added) {
      deps.hub.publishToUsers([peer.id], {
        type: "group.joined",
        conversationId,
        conversationName: conv.title ?? "Group",
      });
    }
    publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  }
  return getGroup(deps, userId, conversationId);
}

export async function removeGroupMember(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
  req: RemoveGroupMemberRequest,
): Promise<GroupDetail> {
  const actor = await requireAdmin(deps, userId, conversationId);
  const target = await deps.db.conversationMember.findFirst({
    where: { conversationId, userId: req.userId, leftAt: null },
  });
  if (!target) throw notFound("Member not found");
  if (target.userId === actor.userId) throw badRequest("Remove yourself with leave instead");

  await deps.db.conversationMember.update({
    where: { id: target.id },
    data: { leftAt: new Date(), joinState: "ACTIVE" },
  });
  const removed = await deps.db.user.findUnique({ where: { id: target.userId } });
  await postSystemMessage(
    deps,
    conversationId,
    `${actor.user.displayName ?? "An admin"} removed ${removed?.displayName ?? "a member"}`,
  );
  publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  return getGroup(deps, userId, conversationId);
}

export async function setMemberRole(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
  targetUserId: string,
  role: "ADMIN" | "MEMBER",
): Promise<GroupDetail> {
  await requireAdmin(deps, userId, conversationId);
  const target = await deps.db.conversationMember.findFirst({
    where: { conversationId, userId: targetUserId, leftAt: null, joinState: "ACTIVE" },
  });
  if (!target) throw notFound("Member not found");

  if (role === "MEMBER") {
    const admins = await deps.db.conversationMember.count({
      where: { conversationId, leftAt: null, joinState: "ACTIVE", role: "ADMIN" },
    });
    if (admins <= 1) throw badRequest("A group needs at least one admin");
  }
  await deps.db.conversationMember.update({ where: { id: target.id }, data: { role } });

  const actor = await deps.db.user.findUnique({ where: { id: userId } });
  const subject = await deps.db.user.findUnique({ where: { id: targetUserId } });
  await postSystemMessage(
    deps,
    conversationId,
    `${actor?.displayName ?? "An admin"} ${role === "ADMIN" ? "promoted" : "demoted"} ${subject?.displayName ?? "a member"}`,
  );
  publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  return getGroup(deps, userId, conversationId);
}

export async function leaveGroup(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
): Promise<{ ok: true }> {
  const member = await requireActiveMembership(deps, userId, conversationId);
  await deps.db.conversationMember.update({
    where: { id: member.id },
    data: { leftAt: new Date() },
  });
  await postSystemMessage(deps, conversationId, `${member.user.displayName ?? "A member"} left the group`);

  const remaining = await activeMemberCount(deps.db, conversationId);
  if (remaining === 0) {
    await deps.db.conversation.delete({ where: { id: conversationId } });
  } else {
    publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  }
  return { ok: true };
}

export async function deleteGroup(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
): Promise<{ ok: true }> {
  await requireAdmin(deps, userId, conversationId);
  const memberIds = await activeMemberIds(deps, conversationId);
  await deps.db.conversation.delete({ where: { id: conversationId } });
  deps.hub.publishToUsers(
    memberIds.filter((id) => id !== userId),
    { type: "group.changed", conversationId },
  );
  return { ok: true };
}

// ────────────────────────────── joining ──────────────────────────────

export async function joinByCode(
  deps: GroupDeps,
  userId: string,
  code: string,
): Promise<GroupDetail> {
  const profile = await deps.db.groupProfile.findUnique({
    where: { inviteCode: code },
    include: { conversation: { include: { group: true, members: true } } },
  });
  const conv = profile?.conversation;
  if (!profile || !conv || conv.type !== "GROUP") throw notFound("Invalid invite link");
  if (profile.inviteRevokedAt) throw badRequest("This invite link is no longer valid");

  const existing = await deps.db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: conv.id, userId } },
  });
  const alreadyActive = existing && existing.leftAt === null && existing.joinState === "ACTIVE";

  if (!alreadyActive) {
    // PUBLIC groups let anyone in; PRIVATE groups still need admin approval,
    // even through an invite link (requireApproval is the deciding flag).
    const pending =
      profile.visibility === "PRIVATE" && (profile.requireApproval || existing === null);
    if (existing) {
      await deps.db.conversationMember.update({
        where: { id: existing.id },
        data: {
          leftAt: null,
          joinState: pending ? "PENDING" : "ACTIVE",
          ...(pending ? {} : { joinedAt: new Date() }),
        },
      });
    } else {
      await deps.db.conversationMember.create({
        data: { conversationId: conv.id, userId, joinState: pending ? "PENDING" : "ACTIVE" },
      });
    }
    if (!pending) {
      await announceJoin(deps, conv.id, userId);
    }
  }
  return getGroup(deps, userId, conv.id);
}

export async function applyToJoin(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
): Promise<{ pending: boolean }> {
  const conv = await requireGroup(deps, conversationId);
  const profile = conv.group!;

  const existing = await deps.db.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (existing && existing.leftAt === null && existing.joinState === "ACTIVE") {
    throw badRequest("You are already in this group");
  }
  if (existing && existing.leftAt === null && existing.joinState === "PENDING") {
    return { pending: true };
  }

  // PUBLIC groups join immediately; PRIVATE groups create a join request.
  const isPublic = profile.visibility === "PUBLIC";
  if (existing) {
    await deps.db.conversationMember.update({
      where: { id: existing.id },
      data: { leftAt: null, joinState: isPublic ? "ACTIVE" : "PENDING", ...(isPublic ? { joinedAt: new Date() } : {}) },
    });
  } else {
    await deps.db.conversationMember.create({
      data: { conversationId, userId, joinState: isPublic ? "ACTIVE" : "PENDING" },
    });
  }

  if (isPublic) {
    await announceJoin(deps, conversationId, userId);
    return { pending: false };
  }

  const applicant = await deps.db.conversationMember.findFirstOrThrow({
    where: { conversationId, userId, joinState: "PENDING" },
    include: memberInclude,
  });
  await notifyJoinRequest(deps, conv, applicant);
  return { pending: true };
}

/** Tell every admin that a join request is waiting (5E also uses this for
 *  re-adds an ordinary member is not trusted to complete). */
async function notifyJoinRequest(
  deps: GroupDeps,
  conv: ConversationWithGroup,
  applicant: MemberRow,
): Promise<void> {
  const admins = await deps.db.conversationMember.findMany({
    where: { conversationId: conv.id, leftAt: null, joinState: "ACTIVE", role: "ADMIN" },
    select: { userId: true },
  });
  deps.hub.publishToUsers(
    admins.map((a) => a.userId),
    {
      type: "group.joinRequest.new",
      conversationId: conv.id,
      conversationName: conv.title ?? "Group",
      user: toMember(applicant),
    },
  );
}

export async function approveJoinRequest(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
  applicantId: string,
): Promise<GroupDetail> {
  await requireAdmin(deps, userId, conversationId);
  const request = await deps.db.conversationMember.findFirst({
    where: { conversationId, userId: applicantId, joinState: "PENDING", leftAt: null },
  });
  if (!request) throw notFound("Join request not found");

  await deps.db.conversationMember.update({
    where: { id: request.id },
    data: { joinState: "ACTIVE", leftAt: null, joinedAt: new Date() },
  });
  const conv = await requireGroup(deps, conversationId);
  await announceJoin(deps, conversationId, applicantId);
  deps.hub.publishToUsers([applicantId], {
    type: "group.joined",
    conversationId,
    conversationName: conv.title ?? "Group",
  });
  publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  return getGroup(deps, userId, conversationId);
}

export async function rejectJoinRequest(
  deps: GroupDeps,
  userId: string,
  conversationId: string,
  applicantId: string,
): Promise<GroupDetail> {
  await requireAdmin(deps, userId, conversationId);
  const request = await deps.db.conversationMember.findFirst({
    where: { conversationId, userId: applicantId, joinState: "PENDING", leftAt: null },
  });
  if (!request) throw notFound("Join request not found");

  await deps.db.conversationMember.update({
    where: { id: request.id },
    data: { joinState: "REJECTED", leftAt: new Date() },
  });
  publishToGroup(deps, conversationId, { type: "group.changed", conversationId });
  return getGroup(deps, userId, conversationId);
}

// ────────────────────────────── helpers ──────────────────────────────

async function announceJoin(
  deps: GroupDeps,
  conversationId: string,
  userId: string,
): Promise<void> {
  const user = await deps.db.user.findUnique({ where: { id: userId } });
  await postSystemMessage(deps, conversationId, `${user?.displayName ?? "A member"} joined the group`);
}

async function activeMemberIds(deps: GroupDeps, conversationId: string): Promise<string[]> {
  const rows = await deps.db.conversationMember.findMany({
    where: { conversationId, leftAt: null, joinState: "ACTIVE" },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function requirePhoneUser(db: GroupDeps["db"], userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { phoneIdentity: true },
  });
  if (!user?.phoneIdentity) throw forbidden("Connect a phone number to start using Chats");
  return user;
}

/** Resolve phones to accounts; unknown numbers are ignored (no enumeration). */
async function resolvePhones(
  db: GroupDeps["db"],
  phones: string[],
  excludeSelf: string,
): Promise<Array<{ id: string; displayName: string | null; phone: string; groupAddVisibility: GroupAddVisibility }>> {
  const identities = await db.phoneIdentity.findMany({
    where: { phone: { in: phones }, user: { status: "ACTIVE" } },
    include: { user: { select: { id: true, displayName: true, groupAddVisibility: true } } },
  });
  const seen = new Set<string>();
  const out: Array<{
    id: string;
    displayName: string | null;
    phone: string;
    groupAddVisibility: GroupAddVisibility;
  }> = [];
  for (const identity of identities) {
    if (identity.userId === excludeSelf || seen.has(identity.userId)) continue;
    seen.add(identity.userId);
    out.push({
      id: identity.userId,
      displayName: identity.user.displayName,
      phone: identity.phone,
      groupAddVisibility: identity.user.groupAddVisibility,
    });
  }
  return out;
}
