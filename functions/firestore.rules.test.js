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
    await setDoc(doc(db, "events", "annual-2026", "participants", "p1"), { name: "王小明", church: "林南教會", lookupKeyHash: "a".repeat(64), eligible: true, checkedInAt: now, checkInMethod: "self", hasVoted: false, createdAt: now });
    await setDoc(doc(db, "events", "annual-2026", "participants", "p2"), { name: "陳小華", church: "和平教會", lookupKeyHash: "b".repeat(64), eligible: true, checkedInAt: null, hasVoted: false, createdAt: now });
    await setDoc(doc(db, "events", "annual-2026", "tallies", "c1"), { count: 1, updatedAt: now });
  });
});

test.after(async () => { if (env) await env.cleanup(); });
test.beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await setDoc(doc(db, "events", "annual-2026"), { title: "年度大會", electionTitle: "理事選舉", status: "voting", createdAt: now, updatedAt: now });
  await setDoc(doc(db, "events", "annual-2026", "participants", "p1"), { name: "王小明", church: "林南教會", lookupKeyHash: "a".repeat(64), eligible: true, checkedInAt: now, checkInMethod: "self", hasVoted: false, createdAt: now });
  await setDoc(doc(db, "events", "annual-2026", "participants", "p2"), { name: "陳小華", church: "和平教會", lookupKeyHash: "b".repeat(64), eligible: true, checkedInAt: null, hasVoted: false, createdAt: now });
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

test("participant records reject schema pollution and invalid staff audit data", async () => {
  const admin = env.authenticatedContext("admin", { email: "cbroker@gmail.com", email_verified: true }).firestore();
  const base = { name: "林小安", church: "林南教會", lookupKeyHash: "c".repeat(64), eligible: true, checkedInAt: null, hasVoted: false, createdAt: now };
  await assertFails(setDoc(doc(admin, "events", "annual-2026", "participants", "bad-extra"), { ...base, unexpected: "x" }));
  await assertFails(setDoc(doc(admin, "events", "annual-2026", "participants", "bad-staff"), { ...base, checkedInAt: now, checkInMethod: "staff" }));
  await assertSucceeds(setDoc(doc(admin, "events", "annual-2026", "participants", "valid-staff"), { ...base, checkedInAt: now, checkInMethod: "staff", checkedInByUid: "admin" }));
});

test("admin cannot change an imported participant lookup identity in place", async () => {
  const admin = env.authenticatedContext("admin", { email: "cbroker@gmail.com", email_verified: true }).firestore();
  await assertFails(setDoc(doc(admin, "events", "annual-2026", "participants", "p2"), { lookupKeyHash: "d".repeat(64) }, { merge: true }));
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
