import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getDoc, getDocs, getFirestore, onSnapshot, serverTimestamp, setDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
let unsubscribers = [];

$("loginBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(showError);
$("logoutBtn").onclick = () => signOut(auth);
onAuthStateChanged(auth, async (user) => {
  const authorized = user?.email === "cbroker@gmail.com" && user.emailVerified;
  $("loginBtn").classList.toggle("hidden", !!user);
  $("logoutBtn").classList.toggle("hidden", !user);
  $("adminPanel").classList.toggle("hidden", !authorized);
  $("authMessage").textContent = authorized ? `已登入：${user.email}` : user ? "此帳號沒有管理權限。" : "請使用授權的管理員 Google 帳號登入。";
  if (!authorized) unsubscribers.forEach((unsubscribe) => unsubscribe());
});

$("eventId").addEventListener("input", () => {
  const eventId = normalizedEventId();
  $("eventUrl").textContent = eventId ? `${location.origin}/event.html?event=${encodeURIComponent(eventId)}` : "請先輸入活動代碼";
  subscribeStats(eventId);
});

$("saveEvent").onclick = async () => {
  const eventId = normalizedEventId();
  const title = $("title").value.trim();
  const electionTitle = $("electionTitle").value.trim();
  if (!eventId || !title || !electionTitle) return showError(new Error("請完整填寫活動代碼、名稱及投票題目。"));
  try {
    const eventRef = doc(db, "events", eventId);
    const existing = await getDoc(eventRef);
    const data = { title, electionTitle, status: $("status").value, updatedAt: serverTimestamp() };
    if (!existing.exists()) data.createdAt = serverTimestamp();
    await setDoc(eventRef, data, { merge: true });
    showMessage("活動設定已儲存。", false);
  } catch (error) { showError(error); }
};

$("saveCandidates").onclick = async () => {
  const eventId = normalizedEventId();
  const names = $("candidates").value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (!eventId || !names.length) return showError(new Error("請先輸入活動代碼及候選人。"));
  try {
    const existing = await getDocs(collection(db, "events", eventId, "candidates"));
    const desired = [];
    for (const [order, name] of names.entries()) desired.push({ id: (await sha256(name)).slice(0, 32), name, order });
    const desiredIds = new Set(desired.map((candidate) => candidate.id));
    const batch = writeBatch(db);
    existing.forEach((item) => { if (!desiredIds.has(item.id)) batch.delete(item.ref); });
    for (const candidate of desired) {
      const existingCandidate = existing.docs.find((item) => item.id === candidate.id);
      const data = { name: candidate.name, order: candidate.order, active: true };
      if (!existingCandidate) data.createdAt = serverTimestamp();
      batch.set(doc(db, "events", eventId, "candidates", candidate.id), data, { merge: true });
    }
    await batch.commit();
    showMessage(`已儲存 ${names.length} 位候選人。`, false);
  } catch (error) { showError(error); }
};

$("importParticipants").onclick = async () => {
  const eventId = normalizedEventId();
  const rows = $("participants").value.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (!eventId || !rows.length) return showError(new Error("請先輸入活動代碼及參加者名單。"));
  try {
    const parsed = [];
    for (const row of rows) {
      const [name, accessCode, ...extra] = row.split(",").map((value) => value.trim());
      if (!name || !accessCode || extra.length) throw new Error(`格式錯誤：${row}`);
      if (accessCode.length < 8 || accessCode.length > 32) throw new Error(`個人代碼需為 8–32 字元：${name}`);
      parsed.push({ name, accessCodeHash: await sha256(accessCode.toUpperCase()) });
    }
    const batch = writeBatch(db);
    for (const participant of parsed) {
      const participantId = participant.accessCodeHash.slice(0, 32);
      const ref = doc(db, "events", eventId, "participants", participantId);
      const existing = await getDoc(ref);
      const data = { name: participant.name, accessCodeHash: participant.accessCodeHash, eligible: true };
      if (!existing.exists()) Object.assign(data, { checkedInAt: null, hasVoted: false, createdAt: serverTimestamp() });
      batch.set(ref, data, { merge: true });
    }
    await batch.commit();
    $("participantSummary").textContent = `已匯入 ${parsed.length} 位參加者。`;
    $("participantSummary").classList.remove("hidden");
    showMessage("名單匯入完成。", false);
  } catch (error) { showError(error); }
};

function subscribeStats(eventId) {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
  if (!eventId) return;
  let participants = [], candidates = [], tallies = new Map();
  const render = () => {
    const checkedIn = participants.filter((item) => item.checkedInAt).length;
    const voted = participants.filter((item) => item.hasVoted).length;
    $("stats").textContent = `名單 ${participants.length} 人｜已簽到 ${checkedIn} 人｜已投票 ${voted} 人`;
    $("adminResults").innerHTML = candidates.sort((a, b) => a.order - b.order).map((candidate) => `<div class="result-row"><strong>${escapeHtml(candidate.name)}</strong><strong>${tallies.get(candidate.id) || 0} 票</strong></div>`).join("");
  };
  unsubscribers.push(onSnapshot(collection(db, "events", eventId, "participants"), (snapshot) => { participants = snapshot.docs.map((item) => item.data()); render(); }));
  unsubscribers.push(onSnapshot(collection(db, "events", eventId, "candidates"), (snapshot) => { candidates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); render(); }));
  unsubscribers.push(onSnapshot(collection(db, "events", eventId, "tallies"), (snapshot) => { tallies = new Map(snapshot.docs.map((item) => [item.id, item.data().count || 0])); render(); }));
}

function normalizedEventId() { return $("eventId").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, ""); }
async function sha256(value) { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function showError(error) { showMessage(error?.message || "操作失敗。", true); }
function showMessage(text, error) { $("message").textContent = text; $("message").className = `notice ${error ? "error" : "ok"}`; }
