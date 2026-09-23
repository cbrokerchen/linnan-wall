import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getFirestore, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { firebaseConfig, functionsRegion } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, functionsRegion);
const claimParticipant = httpsCallable(functions, "claimParticipant");
const getCheckInOptions = httpsCallable(functions, "getCheckInOptions");
const castVote = httpsCallable(functions, "castVote");
const $ = (id) => document.getElementById(id);
let currentEventId = new URLSearchParams(location.search).get("event") || localStorage.getItem("eventId") || "";
let participantId = localStorage.getItem("participantId") || "";
let eventData = null;
let candidates = [];
let unsubscribers = [];
let unsubscribeTallies = null;
let sharedDeviceMode = false;

$("eventId").value = currentEventId;
onAuthStateChanged(auth, async (user) => {
  if (user && currentEventId && participantId) await resumeSession(user);
});

$("loadEventBtn").onclick = loadCheckInOptions;
if (currentEventId) loadCheckInOptions();

$("joinBtn").onclick = async () => {
  const eventId = $("eventId").value.trim().toLowerCase();
  const name = $("participantInputName").value.trim();
  const church = $("church").value;
  if (!eventId || !name || !church) return showMessage("請輸入姓名並選擇教會。", true);
  setBusy($("joinBtn"), true);
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    const response = await claimParticipant({ eventId, name, church });
    currentEventId = eventId;
    participantId = response.data.participantId;
    sharedDeviceMode = $("sharedDevice").checked;
    localStorage.setItem("eventId", eventId);
    localStorage.setItem("participantId", participantId);
    sessionStorage.setItem("sharedDeviceMode", sharedDeviceMode ? "1" : "0");
    await auth.currentUser.getIdToken(true);
    startListeners(response.data.name, response.data.hasVoted);
  } catch (error) {
    showMessage(readableError(error), true);
  } finally {
    setBusy($("joinBtn"), false);
  }
};

$("voteForm").onsubmit = async (event) => {
  event.preventDefault();
  const choice = document.querySelector('input[name="candidate"]:checked');
  const writeInName = $("writeInName").value.trim();
  if (!choice && !writeInName) return showMessage("請選擇一位候選人，或輸入候選人姓名。", true);
  const choiceDescription = writeInName || choice.closest("label")?.innerText.trim() || "所選候選人";
  if (!confirm(`送出後不能修改，確定投給「${choiceDescription}」嗎？`)) return;
  setBusy($("voteBtn"), true);
  try {
    await castVote(writeInName ? { eventId: currentEventId, writeInName } : { eventId: currentEventId, candidateId: choice.value });
    $("voteForm").classList.add("hidden");
    $("voted").classList.remove("hidden");
    showMessage("投票完成。", false);
    if (sharedDeviceMode) await clearSharedDeviceSession();
  } catch (error) {
    showMessage(readableError(error), true);
  } finally {
    setBusy($("voteBtn"), false);
  }
};

$("nextParticipantBtn").onclick = () => resetForNextParticipant();
$("candidateList").addEventListener("change", () => { $("writeInName").value = ""; });
$("writeInName").addEventListener("input", () => {
  document.querySelectorAll('input[name="candidate"]').forEach((input) => { input.checked = false; });
});

async function loadCheckInOptions() {
  const eventId = $("eventId").value.trim().toLowerCase();
  if (!eventId) return showMessage("請先輸入活動代碼。", true);
  setBusy($("loadEventBtn"), true);
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    const response = await getCheckInOptions({ eventId });
    currentEventId = eventId;
    localStorage.setItem("eventId", eventId);
    $("pageTitle").textContent = response.data.title;
    $("church").innerHTML = '<option value="">請選擇教會</option>' + response.data.churches.map((church) => `<option value="${escapeHtml(church)}">${escapeHtml(church)}</option>`).join("");
    $("identityFields").classList.remove("hidden");
    showMessage(`已載入 ${response.data.churches.length} 個教會選項。`, false);
  } catch (error) { showMessage(readableError(error), true); }
  finally { setBusy($("loadEventBtn"), false); }
}

async function resumeSession(user) {
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.eventId !== currentEventId || token.claims.participantId !== participantId) return;
    sharedDeviceMode = sessionStorage.getItem("sharedDeviceMode") === "1";
    startListeners("", false);
  } catch (error) {
    showMessage(readableError(error), true);
  }
}

async function clearSharedDeviceSession() {
  localStorage.removeItem("participantId");
  sessionStorage.removeItem("sharedDeviceMode");
  participantId = "";
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
  if (unsubscribeTallies) unsubscribeTallies();
  unsubscribeTallies = null;
  await signOut(auth);
  $("nextParticipantBtn").classList.remove("hidden");
}

function resetForNextParticipant() {
  sharedDeviceMode = false;
  eventData = null;
  candidates = [];
  $("participantInputName").value = "";
  $("church").value = "";
  $("sharedDevice").checked = true;
  $("statusCard").classList.add("hidden");
  $("joinCard").classList.remove("hidden");
  $("nextParticipantBtn").classList.add("hidden");
  $("voted").classList.add("hidden");
  showMessage("已清除上一位參加者的登入狀態，請下一位開始簽到。", false);
}

function startListeners(name, hasVoted) {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  if (unsubscribeTallies) unsubscribeTallies();
  unsubscribers = [];
  unsubscribeTallies = null;
  $("joinCard").classList.add("hidden");
  $("statusCard").classList.remove("hidden");
  if (name) $("participantName").textContent = name;
  if (hasVoted) $("voted").classList.remove("hidden");

  unsubscribers.push(onSnapshot(doc(db, "events", currentEventId), (snapshot) => {
    if (!snapshot.exists()) return showMessage("找不到活動。", true);
    eventData = snapshot.data();
    $("pageTitle").textContent = eventData.title;
    $("eventStatus").textContent = statusLabel(eventData.status);
    if (eventData.status === "results" && !unsubscribeTallies) subscribeTallies();
    if (eventData.status !== "results" && unsubscribeTallies) { unsubscribeTallies(); unsubscribeTallies = null; }
    renderState();
  }, (error) => showMessage(readableError(error), true)));

  unsubscribers.push(onSnapshot(doc(db, "events", currentEventId, "participants", participantId), (snapshot) => {
    if (!snapshot.exists()) return;
    const participant = snapshot.data();
    $("participantName").textContent = participant.name;
    $("voted").classList.toggle("hidden", !participant.hasVoted);
    renderState(participant.hasVoted);
  }));

  const candidateQuery = query(collection(db, "events", currentEventId, "candidates"), where("active", "==", true));
  unsubscribers.push(onSnapshot(candidateQuery, (snapshot) => {
    candidates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh-Hant"));
    renderCandidates();
  }));

}

function subscribeTallies() {
  unsubscribeTallies = onSnapshot(collection(db, "events", currentEventId, "tallies"), (snapshot) => {
    const tallies = new Map(snapshot.docs.map((item) => [item.id, item.data().count || 0]));
    renderResults(tallies);
  }, (error) => showMessage(readableError(error), true));
}

function renderState(hasVoted = !$("voted").classList.contains("hidden")) {
  if (!eventData) return;
  const voting = eventData.status === "voting";
  const results = eventData.status === "results";
  $("waiting").classList.toggle("hidden", voting || results || hasVoted);
  $("voteForm").classList.toggle("hidden", !voting || hasVoted);
  $("results").classList.toggle("hidden", !results);
  $("electionTitle").textContent = eventData.electionTitle || "請選擇一位候選人";
}

function renderCandidates() {
  $("candidateList").innerHTML = candidates.map((candidate) => `
    <label class="choice"><input type="radio" name="candidate" value="${escapeHtml(candidate.id)}"><span>${escapeHtml(candidate.name)}</span></label>
  `).join("") || '<div class="notice">尚未設定候選人。</div>';
}

function renderResults(tallies) {
  const total = [...tallies.values()].reduce((sum, count) => sum + count, 0);
  $("resultList").innerHTML = candidates.map((candidate) => {
    const count = tallies.get(candidate.id) || 0;
    const percent = total ? Math.round(count / total * 100) : 0;
    return `<div class="result-row"><div><strong>${escapeHtml(candidate.name)}</strong><div class="bar"><i style="width:${percent}%"></i></div></div><strong>${count} 票</strong></div>`;
  }).join("");
}

function statusLabel(status) { return ({ checkin: "簽到中", voting: "投票中", closed: "已截止", results: "結果公布" })[status] || status; }
function setBusy(button, busy) { button.disabled = busy; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function readableError(error) {
  const code = String(error?.code || "").replace("functions/", "");
  return ({ "not-found": error.message || "找不到相符的報名資料。", "failed-precondition": error.message, "already-exists": "你已經投過票。", "permission-denied": "你沒有執行此操作的權限。", unauthenticated: "登入狀態已失效，請重新整理。" })[code] || error?.message || "操作失敗，請稍後再試。";
}
function showMessage(text, error) { $("message").textContent = text; $("message").className = `notice ${error ? "error" : "ok"}`; }
