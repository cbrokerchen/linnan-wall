import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getDoc, getDocs, getFirestore, onSnapshot, serverTimestamp, setDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { firebaseConfig, functionsRegion } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, functionsRegion);
const staffCheckIn = httpsCallable(functions, "staffCheckIn");
const $ = (id) => document.getElementById(id);
const EVENT_ID = "registration-test";
let unsubscribers = [];
let adminInitialized = false;

$("loginBtn").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch(showError);
$("logoutBtn").onclick = () => signOut(auth);
onAuthStateChanged(auth, async (user) => {
  const authorized = user?.email === "cbroker@gmail.com" && user.emailVerified;
  $("loginBtn").classList.toggle("hidden", !!user);
  $("logoutBtn").classList.toggle("hidden", !user);
  $("adminPanel").classList.toggle("hidden", !authorized);
  $("authMessage").textContent = authorized ? `已登入：${user.email}` : user ? "此帳號沒有管理權限。" : "請使用授權的管理員 Google 帳號登入。";
  if (!authorized) {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribers = [];
    adminInitialized = false;
  }
  if (authorized && !adminInitialized) {
    adminInitialized = true;
    $("eventUrl").textContent = `${location.origin}/event.html`;
    subscribeStats(EVENT_ID);
    await loadEventSettings();
  }
});

async function loadEventSettings() {
  try {
    const snapshot = await getDoc(doc(db, "events", EVENT_ID));
    if (!snapshot.exists()) throw new Error("找不到活動設定。請填妥活動名稱及投票題目後儲存。");
    const data = snapshot.data();
    $("title").value = data.title || "";
    $("electionTitle").value = data.electionTitle || "";
    $("status").value = data.status || "checkin";
    showMessage(`已載入活動設定：${data.title}`, false);
  } catch (error) { showError(error); }
}

$("saveEvent").onclick = async () => {
  const title = $("title").value.trim();
  const electionTitle = $("electionTitle").value.trim();
  if (!title || !electionTitle) return showError(new Error("請完整填寫活動名稱及投票題目。"));
  try {
    const eventRef = doc(db, "events", EVENT_ID);
    const existing = await getDoc(eventRef);
    const data = { title, electionTitle, status: $("status").value, updatedAt: serverTimestamp() };
    if (!existing.exists()) data.createdAt = serverTimestamp();
    await setDoc(eventRef, data, { merge: true });
    showMessage("活動設定已儲存。", false);
  } catch (error) { showError(error); }
};

$("saveCandidates").onclick = async () => {
  const eventId = EVENT_ID;
  const names = $("candidates").value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (!names.length) return showError(new Error("請先輸入候選人。"));
  try {
    const existing = await getDocs(collection(db, "events", eventId, "candidates"));
    const desired = [];
    for (const [order, name] of names.entries()) desired.push({ id: await candidateIdFromName(name), name, order });
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
  const eventId = EVENT_ID;
  const rows = $("participants").value.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (!rows.length) return showError(new Error("請先輸入參加者名單。"));
  try {
    const parsed = [];
    for (const row of rows) {
      const [name, church, ...extra] = row.split(",").map(normalizedIdentityText);
      if (!name || !church || extra.length) throw new Error(`格式錯誤：${row}`);
      if (name.length > 80 || church.length > 100) throw new Error(`姓名或教會名稱過長：${name}`);
      const lookupKeyHash = await participantLookupHash(name, church);
      if (parsed.some((item) => item.lookupKeyHash === lookupKeyHash)) throw new Error(`同名且同教會的資料重複：${name}（${church}）`);
      parsed.push({ name, church, lookupKeyHash });
    }
    const batch = writeBatch(db);
    for (const participant of parsed) {
      const participantId = participant.lookupKeyHash.slice(0, 32);
      const ref = doc(db, "events", eventId, "participants", participantId);
      const existing = await getDoc(ref);
      const data = { name: participant.name, church: participant.church, lookupKeyHash: participant.lookupKeyHash, eligible: true };
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
    $("participantRoster").innerHTML = participants
      .sort((a, b) => a.church.localeCompare(b.church, "zh-Hant") || a.name.localeCompare(b.name, "zh-Hant"))
      .map((participant) => `<div class="list-item participant-row"><div><strong>${escapeHtml(participant.name)}</strong><small>${escapeHtml(participant.church)}｜${participant.checkedInAt ? `已簽到（${participant.checkInMethod === "staff" ? "工作人員" : "本人"}）` : "尚未簽到"}</small></div><button class="${participant.checkedInAt ? "secondary" : ""}" data-staff-checkin="${escapeHtml(participant.id)}" ${participant.checkedInAt ? "disabled" : ""}>${participant.checkedInAt ? "已簽到" : "工作人員代簽"}</button></div>`)
      .join("") || '<div class="notice">尚未匯入參加者。</div>';
  };
  unsubscribers.push(onSnapshot(collection(db, "events", eventId, "participants"), (snapshot) => { participants = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); render(); }));
  unsubscribers.push(onSnapshot(collection(db, "events", eventId, "candidates"), (snapshot) => { candidates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); render(); }));
  unsubscribers.push(onSnapshot(collection(db, "events", eventId, "tallies"), (snapshot) => { tallies = new Map(snapshot.docs.map((item) => [item.id, item.data().count || 0])); render(); }));
}

$("participantRoster").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-staff-checkin]");
  if (!button) return;
  const eventId = EVENT_ID;
  if (!confirm("已核對姓名與教會，確定由工作人員代為簽到嗎？")) return;
  setBusy(button, true);
  try {
    const response = await staffCheckIn({ eventId, participantId: button.dataset.staffCheckin });
    showMessage(`${response.data.name}（${response.data.church}）已完成代簽。`, false);
  } catch (error) { showError(error); }
  finally { setBusy(button, false); }
});

async function sha256(value) { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function normalizedIdentityText(value) { return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " "); }
async function participantLookupHash(name, church) { return sha256(`${normalizedIdentityText(name).toLowerCase()}\n${normalizedIdentityText(church).toLowerCase()}`); }
async function candidateIdFromName(name) { return (await sha256(normalizedIdentityText(name).toLowerCase())).slice(0, 32); }
function setBusy(button, busy) { button.disabled = busy; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function showError(error) { showMessage(error?.message || "操作失敗。", true); }
function showMessage(text, error) { $("message").textContent = text; $("message").className = `notice ${error ? "error" : "ok"}`; }
