const { createHash } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

initializeApp();
const db = getFirestore();
const REGION = "asia-east1";
const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/;

exports.claimParticipant = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入。");
  const eventId = normalizedEventId(request.data?.eventId);
  const accessCode = normalizedAccessCode(request.data?.accessCode);
  if (!EVENT_ID_PATTERN.test(eventId) || accessCode.length < 8 || accessCode.length > 32) throw new HttpsError("invalid-argument", "活動或個人代碼格式不正確。");

  const eventRef = db.doc(`events/${eventId}`);
  const event = await eventRef.get();
  if (!event.exists) throw new HttpsError("not-found", "找不到活動。");

  const codeHash = sha256(accessCode);
  const matches = await eventRef.collection("participants").where("accessCodeHash", "==", codeHash).limit(2).get();
  if (matches.size !== 1) throw new HttpsError("not-found", "活動或個人代碼不正確。");
  const participantRef = matches.docs[0].ref;
  const result = await db.runTransaction(async (transaction) => {
    const [eventSnapshot, participantSnapshot] = await Promise.all([transaction.get(eventRef), transaction.get(participantRef)]);
    if (!eventSnapshot.exists || eventSnapshot.data().status !== "checkin") throw new HttpsError("failed-precondition", "目前不是簽到時間。");
    const participant = participantSnapshot.data();
    if (!participant.eligible) throw new HttpsError("permission-denied", "你目前沒有投票資格。");
    transaction.update(participantRef, { checkedInAt: participant.checkedInAt || FieldValue.serverTimestamp(), lastAuthUid: request.auth.uid, updatedAt: FieldValue.serverTimestamp() });
    return { participantId: participantRef.id, name: participant.name, hasVoted: participant.hasVoted === true };
  });

  await getAuth().setCustomUserClaims(request.auth.uid, { eventId, participantId: result.participantId });
  return result;
});

exports.castVote = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入。");
  const eventId = normalizedEventId(request.data?.eventId);
  const candidateId = String(request.data?.candidateId || "");
  if (!EVENT_ID_PATTERN.test(eventId) || !candidateId || candidateId.length > 128) throw new HttpsError("invalid-argument", "選票格式不正確。");
  if (request.auth.token.eventId !== eventId || typeof request.auth.token.participantId !== "string") throw new HttpsError("permission-denied", "簽到憑證不符。");

  const participantId = request.auth.token.participantId;
  const eventRef = db.doc(`events/${eventId}`);
  const participantRef = eventRef.collection("participants").doc(participantId);
  const candidateRef = eventRef.collection("candidates").doc(candidateId);
  const receiptRef = eventRef.collection("voteReceipts").doc(participantId);
  const tallyRef = eventRef.collection("tallies").doc(candidateId);

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, participantSnapshot, candidateSnapshot, receiptSnapshot] = await Promise.all([
      transaction.get(eventRef), transaction.get(participantRef), transaction.get(candidateRef), transaction.get(receiptRef)
    ]);
    validateVoteState({
      event: eventSnapshot.exists ? eventSnapshot.data() : null,
      participant: participantSnapshot.exists ? participantSnapshot.data() : null,
      candidate: candidateSnapshot.exists ? candidateSnapshot.data() : null,
      receiptExists: receiptSnapshot.exists
    });

    transaction.set(receiptRef, { used: true, votedAt: FieldValue.serverTimestamp() });
    transaction.set(tallyRef, { count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.update(participantRef, { hasVoted: true, votedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  return { accepted: true };
});

function normalizedEventId(value) { return String(value || "").trim().toLowerCase(); }
function normalizedAccessCode(value) { return String(value || "").trim().toUpperCase(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function validateVoteState({ event, participant, candidate, receiptExists }) {
  if (!event || event.status !== "voting") throw new HttpsError("failed-precondition", "目前未開放投票。");
  if (!participant) throw new HttpsError("permission-denied", "找不到參加者資格。");
  if (!participant.eligible || !participant.checkedInAt) throw new HttpsError("permission-denied", "尚未完成簽到或沒有投票資格。");
  if (participant.hasVoted || receiptExists) throw new HttpsError("already-exists", "你已經投過票。");
  if (!candidate || candidate.active !== true) throw new HttpsError("invalid-argument", "候選人無效。");
}

exports._test = { normalizedEventId, normalizedAccessCode, sha256, validateVoteState, EVENT_ID_PATTERN };
