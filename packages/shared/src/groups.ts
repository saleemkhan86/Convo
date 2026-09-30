import { z } from "zod";
import { e164PhoneSchema } from "./identity.js";

/**
 * Group chat contracts (Phase 4B, spec §9).
 *
 * Groups are conversations with a GroupProfile side-car:
 * - PRIVATE: entry requires an admin invite or approval of a join request.
 * - PUBLIC: anyone with the invite link (or from discovery) can join directly.
 * Admin/member capabilities mirror WhatsApp: who can send, who can edit,
 * announce-only mode, add/remove members, promote/demote.
 */

export const groupVisibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
export type GroupVisibility = z.infer<typeof groupVisibilitySchema>;

export const groupMemberRoleSchema = z.enum(["MEMBER", "ADMIN"]);
export type GroupMemberRole = z.infer<typeof groupMemberRoleSchema>;

export const groupJoinStateSchema = z.enum(["ACTIVE", "PENDING"]);
export type GroupJoinState = z.infer<typeof groupJoinStateSchema>;

export const groupPermissionSchema = z.enum(["ALL", "ADMINS"]);
export type GroupPermission = z.infer<typeof groupPermissionSchema>;

export const groupSettingsSchema = z.object({
  visibility: groupVisibilitySchema,
  whoCanSend: groupPermissionSchema,
  whoCanEdit: groupPermissionSchema,
  /** Who may read/share the invite link (Phase 5E). */
  whoCanInvite: groupPermissionSchema.default("ALL"),
  announceOnly: z.boolean(),
  requireApproval: z.boolean(),
});
export type GroupSettings = z.infer<typeof groupSettingsSchema>;

export const groupSummarySchema = z.object({
  conversationId: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  about: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  settings: groupSettingsSchema,
  /** Caller's role; null when the caller is not a member (preview via link). */
  myRole: groupMemberRoleSchema.nullable(),
  inviteCode: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type GroupSummary = z.infer<typeof groupSummarySchema>;

export const groupMemberSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  phone: z.string().nullable(),
  role: groupMemberRoleSchema,
  joinState: groupJoinStateSchema,
  joinedAt: z.string().datetime().nullable(),
});
export type GroupMember = z.infer<typeof groupMemberSchema>;

export const groupDetailSchema = groupSummarySchema.extend({
  /** Members (ACTIVE) — visible to members; PENDING requests are admin-only. */
  members: z.array(groupMemberSchema),
  /** Pending join requests; empty (and hidden) unless the caller is an admin. */
  joinRequests: z.array(groupMemberSchema),
});
export type GroupDetail = z.infer<typeof groupDetailSchema>;

export const groupListSchema = z.object({
  groups: z.array(groupSummarySchema),
  nextCursor: z.string().nullable(),
});
export type GroupList = z.infer<typeof groupListSchema>;

export const createGroupRequestSchema = z.object({
  name: z.string().trim().min(1, "Group needs a name").max(80),
  about: z.string().trim().max(200).optional(),
  avatarUrl: z.string().trim().max(2048).optional(),
  /** Uploaded group icon (Phase 5E); takes precedence over `avatarUrl`. */
  avatarStorageKey: z.string().uuid().optional(),
  visibility: groupVisibilitySchema.default("PRIVATE"),
  phones: z.array(e164PhoneSchema).max(25).optional(),
});
export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

export const updateGroupRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  about: z.string().trim().max(200).nullable().optional(),
  avatarUrl: z.string().trim().max(2048).nullable().optional(),
  /** Set to swap the icon; null clears it (Phase 5E). */
  avatarStorageKey: z.string().uuid().nullable().optional(),
  settings: groupSettingsSchema.partial().optional(),
});
export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;

export const addGroupMembersRequestSchema = z.object({
  phones: z.array(e164PhoneSchema).min(1).max(25),
});
export type AddGroupMembersRequest = z.infer<typeof addGroupMembersRequestSchema>;

export const removeGroupMemberRequestSchema = z.object({
  userId: z.string().min(1),
});
export type RemoveGroupMemberRequest = z.infer<typeof removeGroupMemberRequestSchema>;

export const resolveJoinRequestSchema = z.object({
  userId: z.string().min(1),
});
export type ResolveJoinRequest = z.infer<typeof resolveJoinRequestSchema>;

/** Alias used by the approve/reject endpoints. */
export const approveJoinRequestSchema = resolveJoinRequestSchema;

/** Body/query for role changes (promote/demote). */
export const groupMemberRefSchema = z.object({
  userId: z.string().min(1),
});
export type GroupMemberRef = z.infer<typeof groupMemberRefSchema>;

export const joinByCodeRequestSchema = z.object({
  code: z.string().trim().min(8).max(64),
});
export type JoinByCodeRequest = z.infer<typeof joinByCodeRequestSchema>;

export const discoverGroupsQuerySchema = z.object({
  q: z.string().trim().min(1).max(50),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type DiscoverGroupsQuery = z.infer<typeof discoverGroupsQuerySchema>;

/** Server → client: group membership/settings changed. */
export const groupChangedEventSchema = z.object({
  type: z.literal("group.changed"),
  conversationId: z.string(),
});
export type GroupChangedEvent = z.infer<typeof groupChangedEventSchema>;

/** Server → client (admins only): someone asked to join a private group. */
export const groupJoinRequestNewEventSchema = z.object({
  type: z.literal("group.joinRequest.new"),
  conversationId: z.string(),
  conversationName: z.string(),
  user: groupMemberSchema,
});
export type GroupJoinRequestNewEvent = z.infer<typeof groupJoinRequestNewEventSchema>;

/** Server → client (applicant only): an admin approved their join request. */
export const groupJoinedEventSchema = z.object({
  type: z.literal("group.joined"),
  conversationId: z.string(),
  conversationName: z.string(),
});
export type GroupJoinedEvent = z.infer<typeof groupJoinedEventSchema>;
