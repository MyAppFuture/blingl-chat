import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  primaryKey,
  uniqueIndex,
  index,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------- Enums ----------

export const messageTypeEnum = pgEnum('message_type', [
  'text',
  'image',
  'gif',
  'system',
]);

// ---------- conversations ----------
// One canonical conversation per user pair.
// CHECK constraint ensures user_a_id < user_b_id so normalization is enforced at the DB.
// (The < check also implicitly prevents self-conversations since equality isn't less-than.)
// next_sequence_number is used for atomic allocation of per-conversation message seq numbers.

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userAId: uuid('user_a_id').notNull(),
    userBId: uuid('user_b_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    nextSequenceNumber: bigint('next_sequence_number', { mode: 'number' })
      .notNull()
      .default(1),
  },
  (table) => ({
    userPairUnique: uniqueIndex('conversations_user_pair_unique').on(
      table.userAId,
      table.userBId
    ),
    userAIdx: index('conversations_user_a_last_message_idx').on(
      table.userAId,
      table.lastMessageAt.desc()
    ),
    userBIdx: index('conversations_user_b_last_message_idx').on(
      table.userBId,
      table.lastMessageAt.desc()
    ),
    userOrderCheck: check(
      'conversations_user_order_check',
      sql`${table.userAId} < ${table.userBId}`
    ),
  })
);

// ---------- messages ----------
// sequence_number is allocated per-conversation, monotonic, gap-free within a conversation.
// client_nonce + conversation_id is the idempotency key for safe retries.
// deleted_at is nullable for soft deletes.
// reply_to_id intentionally has no FK — soft-delete handles the common case, and
//   we want flexibility for future hard-deletes (GDPR, abuse) without CASCADE/SET NULL
//   surprises. Handle "message not found" at read time in the API layer.

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').notNull(),
    sequenceNumber: bigint('sequence_number', { mode: 'number' }).notNull(),
    clientNonce: text('client_nonce').notNull(),
    content: text('content').notNull(),
    messageType: messageTypeEnum('message_type').notNull().default('text'),
    replyToId: uuid('reply_to_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    conversationSequenceUnique: uniqueIndex(
      'messages_conversation_sequence_unique'
    ).on(table.conversationId, table.sequenceNumber),
    conversationNonceUnique: uniqueIndex(
      'messages_conversation_nonce_unique'
    ).on(table.conversationId, table.clientNonce),
    conversationSequenceDescIdx: index(
      'messages_conversation_sequence_desc_idx'
    ).on(table.conversationId, table.sequenceNumber.desc()),
    conversationCreatedDescIdx: index(
      'messages_conversation_created_desc_idx'
    ).on(table.conversationId, table.createdAt.desc()),
  })
);

// ---------- message_reads ----------
// Composite PK (user_id, message_id). One read row per user per message.

export const messageReads = pgTable(
  'message_reads',
  {
    userId: uuid('user_id').notNull(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.messageId] }),
    userIdx: index('message_reads_user_idx').on(table.userId),
  })
);

// ---------- message_reactions ----------
// Composite PK (message_id, user_id, emoji). A user can add multiple different emojis
// to one message, but not the same emoji twice.

export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
  })
);

// ---------- blocked_users ----------
// Directional block. (blocker, blocked) is the PK.
// Index on blocked_id for reverse lookups ("who has blocked me?").
// CHECK constraint prevents users from blocking themselves.

export const blockedUsers = pgTable(
  'blocked_users',
  {
    blockerId: uuid('blocker_id').notNull(),
    blockedId: uuid('blocked_id').notNull(),
    blockedAt: timestamp('blocked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.blockerId, table.blockedId] }),
    blockedIdx: index('blocked_users_blocked_idx').on(table.blockedId),
    notSelfCheck: check(
      'blocked_users_not_self_check',
      sql`${table.blockerId} <> ${table.blockedId}`
    ),
  })
);