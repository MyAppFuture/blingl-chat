import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import {
  conversations,
  messages,
  messageReads,
  messageReactions,
  blockedUsers,
} from './schema.js';

// ---------- Test user UUIDs (these represent Supabase auth users) ----------
const ALICE = 'd1d49e56-e3e3-406c-ac8b-dee742044be6';
const BOB = '22222222-2222-2222-2222-222222222222';
const CAROL = '33333333-3333-3333-3333-333333333333';

// ---------- Helpers ----------

// Always put the lexicographically smaller UUID first so the
// conversations.user_order_check CHECK constraint is satisfied
// and we hit the conversations_user_pair_unique index.
function pair(userA, userB) {
  return userA < userB ? [userA, userB] : [userB, userA];
}

// Atomic per-conversation sequence allocator.
// This is the same pattern we'll use in Phase 3 for the real send endpoint.
async function allocateSequence(db, conversationId) {
  const result = await db.execute(sql`
    UPDATE conversations
    SET next_sequence_number = next_sequence_number + 1
    WHERE id = ${conversationId}
    RETURNING next_sequence_number - 1 AS seq
  `);
  return Number(result.rows[0].seq);
}

// ---------- Main ----------

async function seed() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log('🌱 Seeding database...');

  // Wipe everything (safe for dev only)
  // Order matters because of FKs — but ON DELETE CASCADE handles reads/reactions.
  console.log('  Clearing existing data...');
  await db.delete(blockedUsers);
  await db.delete(messages); // cascades to reads + reactions
  await db.delete(conversations);

  // ---------- Conversations ----------
  console.log('  Creating conversations...');

  const [aliceBobPair] = pair(ALICE, BOB);
  const [, bobPairB] = pair(ALICE, BOB);
  const [aliceCarolPair] = pair(ALICE, CAROL);
  const [, carolPairB] = pair(ALICE, CAROL);

  const [aliceBobConv] = await db
    .insert(conversations)
    .values({ userAId: aliceBobPair, userBId: bobPairB })
    .returning();

  const [aliceCarolConv] = await db
    .insert(conversations)
    .values({ userAId: aliceCarolPair, userBId: carolPairB })
    .returning();

  console.log(`    Alice↔Bob:   ${aliceBobConv.id}`);
  console.log(`    Alice↔Carol: ${aliceCarolConv.id}`);

  // ---------- Messages: Alice ↔ Bob (16 messages, alternating) ----------
  console.log('  Creating Alice↔Bob messages...');

  const aliceBobMessages = [
    { sender: ALICE, content: 'hey! how are you?' },
    { sender: BOB, content: 'not bad, you?' },
    { sender: ALICE, content: 'good — wanna grab coffee later?' },
    { sender: BOB, content: 'sure, where?' },
    { sender: ALICE, content: 'the usual spot?' },
    { sender: BOB, content: 'perfect. 4pm?' },
    { sender: ALICE, content: 'see you then 👋' },
    { sender: BOB, content: '👍' },
    { sender: ALICE, content: 'running 5 min late sorry' },
    { sender: BOB, content: 'no worries' },
    { sender: ALICE, content: 'just parked, walking over' },
    { sender: BOB, content: 'im at a table by the window' },
    { sender: ALICE, content: 'got you, see you in a sec' },
    { sender: BOB, content: 'that was fun, thanks!' },
    { sender: ALICE, content: 'same! let\'s do it again soon' },
    { sender: BOB, content: 'definitely 🫶' },
  ];

  const insertedAliceBob = [];
  for (let i = 0; i < aliceBobMessages.length; i++) {
    const m = aliceBobMessages[i];
    const seq = await allocateSequence(db, aliceBobConv.id);
    const [row] = await db
      .insert(messages)
      .values({
        conversationId: aliceBobConv.id,
        senderId: m.sender,
        sequenceNumber: seq,
        clientNonce: `seed-ab-${i}`,
        content: m.content,
        messageType: 'text',
      })
      .returning();
    insertedAliceBob.push(row);
  }

  // Update conversation's last_message_at + preview (same pattern as Phase 3)
  const lastAB = insertedAliceBob[insertedAliceBob.length - 1];
  await db
    .update(conversations)
    .set({
      lastMessageAt: lastAB.createdAt,
      lastMessagePreview: lastAB.content,
    })
    .where(sql`id = ${aliceBobConv.id}`);

  // ---------- Messages: Alice ↔ Carol (4 messages, quieter) ----------
  console.log('  Creating Alice↔Carol messages...');

  const aliceCarolMessages = [
    { sender: ALICE, content: 'heyyy long time' },
    { sender: CAROL, content: 'I know! how have you been?' },
    { sender: ALICE, content: 'busy but good. you free this weekend?' },
    { sender: CAROL, content: 'yes! brunch sunday?' },
  ];

  const insertedAliceCarol = [];
  for (let i = 0; i < aliceCarolMessages.length; i++) {
    const m = aliceCarolMessages[i];
    const seq = await allocateSequence(db, aliceCarolConv.id);
    const [row] = await db
      .insert(messages)
      .values({
        conversationId: aliceCarolConv.id,
        senderId: m.sender,
        sequenceNumber: seq,
        clientNonce: `seed-ac-${i}`,
        content: m.content,
        messageType: 'text',
      })
      .returning();
    insertedAliceCarol.push(row);
  }

  const lastAC = insertedAliceCarol[insertedAliceCarol.length - 1];
  await db
    .update(conversations)
    .set({
      lastMessageAt: lastAC.createdAt,
      lastMessagePreview: lastAC.content,
    })
    .where(sql`id = ${aliceCarolConv.id}`);

  // ---------- Reads ----------
  // Alice has read all of Bob's messages up to the second-to-last.
  // Bob has read all of Alice's messages.
  console.log('  Creating read receipts...');

  const bobsMessages = insertedAliceBob.filter((m) => m.senderId === BOB);
  const alicesMessagesInAB = insertedAliceBob.filter(
    (m) => m.senderId === ALICE
  );

  // Alice reads all of Bob's except the last one (simulating unread)
  for (const msg of bobsMessages.slice(0, -1)) {
    await db.insert(messageReads).values({
      userId: ALICE,
      messageId: msg.id,
    });
  }

  // Bob reads all of Alice's
  for (const msg of alicesMessagesInAB) {
    await db.insert(messageReads).values({
      userId: BOB,
      messageId: msg.id,
    });
  }

  // ---------- Reactions ----------
  // Bob reacts ❤️ to Alice's "see you then 👋"
  // Alice reacts 😂 to Bob's "👍"
  console.log('  Creating reactions...');

  const seeYouThen = insertedAliceBob.find((m) =>
    m.content.includes('see you then')
  );
  const thumbsUp = insertedAliceBob.find((m) => m.content === '👍');

  await db.insert(messageReactions).values([
    { messageId: seeYouThen.id, userId: BOB, emoji: '❤️' },
    { messageId: thumbsUp.id, userId: ALICE, emoji: '😂' },
  ]);

  // ---------- Summary ----------
  console.log('\n✅ Seed complete');
  console.log(`   Users:         Alice=${ALICE.slice(0, 8)}  Bob=${BOB.slice(0, 8)}  Carol=${CAROL.slice(0, 8)}`);
  console.log(`   Conversations: 2`);
  console.log(`   Messages:      ${insertedAliceBob.length + insertedAliceCarol.length}`);
  console.log(`   Reads:         ${bobsMessages.length - 1 + alicesMessagesInAB.length}`);
  console.log(`   Reactions:     2`);

  await pool.end();
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});