const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, Timestamp } = require("firebase/firestore");

let env;
const projectId = "linnan-wall-rules-test";
const rules = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
const now = Timestamp.now();

test.before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules } });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "events", "annual-2026"), { title: "年度大會", electionTitle: "理事選舉", status: "voting", createdAt: now, updatedAt: now });
    await setDoc(doc(db, "events", "annual-2026", "participants", "p1"), { name: "王小明", accessCodeHash: "a".repeat(64), eligible: true, checkedInAt: now, hasVoted: false, createdAt: now });
    await setDoc(doc(db, "events", "annual-2026", "participants", "p2"), { name: "陳小華", accessCodeHash: "b".repeat(64), eligible: true, checkedInAt: null, hasVoted: false, createdAt: now });
    await setDoc(doc(db, "events", "annual-2026", "tallies", "c1"), { count: 1, updatedAt: now });
  });
});

test.after(async () => { if (env) await env.cleanup(); });
test.beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await setDoc(doc(db, "events", "annual-2026"), { title: "年度大會", electionTitle: "理事選舉", status: "voting", createdAt: now, updatedAt: now });
  await setDoc(doc(db, "events", "annual-2026", "participants", "p1"), { name: "王小明", accessCodeHash: "a".repeat(64), eligible: true, checkedInAt: now, hasVoted: false, createdAt: now });
  await setDoc(doc(db, "events", "annual-2026", "participants", "p2"), { name: "陳小華", accessCodeHash: "b".repeat(64), eligible: true, checkedInAt: null, hasVoted: false, createdAt: now });
  await setDoc(doc(db, "events", "annual-2026", "tallies", "c1"), { count: 1, updatedAt: now });
}); });

test("unauthenticated visitors cannot read event data", async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "events", "annual-2026")));
});

test("participant can read own record but not another participant", async () => {
  const db = env.authenticatedContext("uid-1", { eventId: "annual-2026", participantId: "p1" }).firestore();
  await assertSucceeds(getDoc(doc(db, "events", "annual-2026", "participants", "p1")));
  await assertFails(getDoc(doc(db, "events", "annual-2026", "participants", "p2")));
});

test("participant cannot directly modify eligibility or tally", async () => {
  const db = env.authenticatedContext("uid-1", { eventId: "annual-2026", participantId: "p1" }).firestore();
  await assertFails(setDoc(doc(db, "events", "annual-2026", "participants", "p1"), { eligible: false }, { merge: true }));
  await assertFails(setDoc(doc(db, "events", "annual-2026", "tallies", "c1"), { count: 999 }, { merge: true }));
});

test("participants see tallies only after results are published", async () => {
  const db = env.authenticatedContext("uid-1", { eventId: "annual-2026", participantId: "p1" }).firestore();
  await assertFails(getDoc(doc(db, "events", "annual-2026", "tallies", "c1")));
  await env.withSecurityRulesDisabled((context) => setDoc(doc(context.firestore(), "events", "annual-2026"), { status: "results", updatedAt: Timestamp.now() }, { merge: true }));
  await assertSucceeds(getDoc(doc(db, "events", "annual-2026", "tallies", "c1")));
});

test("verified bootstrap admin can create a strictly validated event", async () => {
  const db = env.authenticatedContext("admin", { email: "cbroker@gmail.com", email_verified: true }).firestore();
  await assertSucceeds(setDoc(doc(db, "events", "new-event"), { title: "新活動", electionTitle: "投票", status: "checkin", createdAt: now, updatedAt: now }));
  await assertFails(setDoc(doc(db, "events", "bad-event"), { title: "新活動", electionTitle: "投票", status: "checkin", createdAt: now, updatedAt: now, isAdmin: true }));
});
