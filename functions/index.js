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
  const name = normalizedIdentityText(request.data?.name);
  const church = normalizedIdentityText(request.data?.church);
  if (!EVENT_ID_PATTERN.test(eventId) || !isValidIdentityText(name, 80) || !isValidIdentityText(church, 100)) {
    throw new HttpsError("invalid-argument", "活動、姓名或教會格式不正確。");
  }

  const eventRef = db.doc(`events/${eventId}`);
  const event = await eventRef.get();
  if (!event.exists) throw new HttpsError("not-found", "找不到活動。");

  const lookupKeyHash = participantLookupHash(name, church);
  const matches = await eventRef.collection("participants").where("lookupKeyHash", "==", lookupKeyHash).limit(2).get();
  if (matches.size !== 1) throw new HttpsError("not-found", "找不到姓名與教會完全相符的報名資料，請洽工作人員。");
  const participantRef = matches.docs[0].ref;
  const result = await db.runTransaction(async (transaction) => {
    const [eventSnapshot, participantSnapshot] = await Promise.all([transaction.get(eventRef), transaction.get(participantRef)]);
    const participant = participantSnapshot.data();
    validateClaimState(eventSnapshot.exists ? eventSnapshot.data() : null, participant);
    transaction.update(participantRef, {
      checkedInAt: participant.checkedInAt || FieldValue.serverTimestamp(),
      checkInMethod: participant.checkedInAt ? participant.checkInMethod || "self" : "self",
      lastAuthUid: request.auth.uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { participantId: participantRef.id, name: participant.name, church: participant.church, hasVoted: participant.hasVoted === true };
  });

  await getAuth().setCustomUserClaims(request.auth.uid, { eventId, participantId: result.participantId });
  return result;
});

exports.getCheckInOptions = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "請先登入。");
  const eventId = normalizedEventId(request.data?.eventId);
  if (!EVENT_ID_PATTERN.test(eventId)) throw new HttpsError("invalid-argument", "活動代碼格式不正確。");
  const eventRef = db.doc(`events/${eventId}`);
  const event = await eventRef.get();
  if (!event.exists) throw new HttpsError("not-found", "找不到活動。");
  if (!["checkin", "voting"].includes(event.data().status)) throw new HttpsError("failed-precondition", "目前不開放簽到或登入投票。");
  const participants = await eventRef.collection("participants").get();
  const churches = [...new Set(participants.docs.map((item) => item.data().church).filter((value) => typeof value === "string"))]
    .sort((a, b) => a.localeCompare(b, "zh-Hant"));
  return { title: event.data().title, churches };
});

exports.staffCheckIn = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  if (!isBootstrapAdminRequest(request)) throw new HttpsError("permission-denied", "只有授權管理員可以代簽。");
  const eventId = normalizedEventId(request.data?.eventId);
  const participantId = String(request.data?.participantId || "");
  if (!EVENT_ID_PATTERN.test(eventId) || !/^[a-f0-9]{32}$/.test(participantId)) throw new HttpsError("invalid-argument", "代簽資料格式不正確。");
  const eventRef = db.doc(`events/${eventId}`);
  const participantRef = eventRef.collection("participants").doc(participantId);
  const result = await db.runTransaction(async (transaction) => {
    const [eventSnapshot, participantSnapshot] = await Promise.all([transaction.get(eventRef), transaction.get(participantRef)]);
    if (!eventSnapshot.exists || eventSnapshot.data().status !== "checkin") throw new HttpsError("failed-precondition", "目前不是簽到時間。");
    if (!participantSnapshot.exists) throw new HttpsError("not-found", "找不到參加者。");
    const participant = participantSnapshot.data();
    transaction.update(participantRef, {
      checkedInAt: participant.checkedInAt || FieldValue.serverTimestamp(),
      checkInMethod: participant.checkedInAt ? participant.checkInMethod || "staff" : "staff",
      checkedInByUid: participant.checkedInByUid || request.auth.uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { name: participant.name, church: participant.church, alreadyCheckedIn: Boolean(participant.checkedInAt) };
  });
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
function normalizedIdentityText(value) { return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " "); }
function isValidIdentityText(value, maxLength) { return value.length >= 1 && value.length <= maxLength; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function participantLookupHash(name, church) { return sha256(`${normalizedIdentityText(name).toLowerCase()}\n${normalizedIdentityText(church).toLowerCase()}`); }
function isBootstrapAdminRequest(request) {
  return request.auth?.token?.email === "cbroker@gmail.com" && request.auth.token.email_verified === true;
}
function validateClaimState(event, participant) {
  if (!event || !["checkin", "voting"].includes(event.status)) throw new HttpsError("failed-precondition", "目前不開放簽到或登入投票。");
  if (!participant?.eligible) throw new HttpsError("permission-denied", "你目前沒有投票資格。");
  if (event.status === "voting" && !participant.checkedInAt) {
    throw new HttpsError("failed-precondition", "一般簽到已截止；若需要公用裝置，請先洽工作人員代簽。");
  }
}
function validateVoteState({ event, participant, candidate, receiptExists }) {
  if (!event || event.status !== "voting") throw new HttpsError("failed-precondition", "目前未開放投票。");
  if (!participant) throw new HttpsError("permission-denied", "找不到參加者資格。");
  if (!participant.eligible || !participant.checkedInAt) throw new HttpsError("permission-denied", "尚未完成簽到或沒有投票資格。");
  if (participant.hasVoted || receiptExists) throw new HttpsError("already-exists", "你已經投過票。");
  if (!candidate || candidate.active !== true) throw new HttpsError("invalid-argument", "候選人無效。");
}

exports._test = { normalizedEventId, normalizedIdentityText, participantLookupHash, sha256, validateClaimState, validateVoteState, EVENT_ID_PATTERN };
