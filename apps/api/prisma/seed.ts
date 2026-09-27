/**
 * Demo seed data.
 *
 * Creates three accounts covering the identity states from spec §3:
 *  - Alice: phone + email (both Chats and Mail)
 *  - Bob:   email only (Mail; prompted to connect a phone)
 *  - Carol: phone only (Chats; prompted to connect an email)
 *
 * Run with: pnpm --filter @convo/api prisma:seed
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main(): Promise<void> {
  const alice = await db.user.upsert({
    where: { id: "seed-alice" },
    create: {
      id: "seed-alice",
      displayName: "Alice Verma",
      bio: "Designing things that talk to each other.",
      phoneIdentity: { create: { phone: "+919800000001" } },
      emailIdentity: { create: { email: "alice@example.com" } },
    },
    update: {},
  });

  const bob = await db.user.upsert({
    where: { id: "seed-bob" },
    create: {
      id: "seed-bob",
      displayName: "Bob Fernandes",
      bio: "Email-first, always.",
      emailIdentity: { create: { email: "bob@example.com" } },
    },
    update: {},
  });

  const carol = await db.user.upsert({
    where: { id: "seed-carol" },
    create: {
      id: "seed-carol",
      displayName: "Carol Singh",
      bio: "Reach me on my phone.",
      phoneIdentity: { create: { phone: "+919800000003" } },
    },
    update: {},
  });

  await db.contact.createMany({
    data: [
      { ownerId: alice.id, displayName: "Bob Fernandes", email: "bob@example.com", convoUserId: bob.id, source: "RECENT" },
      { ownerId: alice.id, displayName: "Carol Singh", phone: "+919800000003", convoUserId: carol.id, source: "RECENT" },
    ],
    skipDuplicates: true,
  });

  await db.auditLog.create({
    data: { action: "seed.demo_data", metadata: { users: [alice.id, bob.id, carol.id] } },
  });

  console.log("Seed complete:");
  console.log("  Alice — +919800000001 / alice@example.com (Chats + Mail)");
  console.log("  Bob   — bob@example.com (Mail only)");
  console.log("  Carol — +919800000003 (Chats only)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
