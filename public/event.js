import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getFirestore, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { firebaseConfig, functionsRegion } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, functionsRegion);
const claimParticipant = httpsCallable(functions, "claimParticipant");
const castVote = httpsCallable(functions, "castVote");
const $ = (id) => document.getElementById(id);
let currentEventId = localStorage.getItem("eventId") || new URLSearchParams(location.search).get("event") || "";
let participantId = localStorage.getItem("participantId") || "";
let eventData = null;
let candidates = [];
let unsubscribers = [];
let unsubscribeTallies = null;

$("eventId").value = currentEventId;
onAuthStateChanged(auth, async (user) => {
  if (!user) await signInAnonymously(auth);
  else if (currentEventId && participantId) await resumeSession(user);
});

$("joinBtn").onclick = async () => {
  const eventId = $("eventId").value.trim().toLowerCase();
  const accessCode = $("accessCode").value.trim();
  if (!eventId || !accessCode) return showMessage("請輸入活動代碼與個人代碼。", true);
  setBusy($("joinBtn"), true);
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    const response = await claimParticipant({ eventId, accessCode });
    currentEventId = eventId;
    participantId = response.data.participantId;
    localStorage.setItem("eventId", eventId);
    localStorage.setItem("participantId", participantId);
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
  if (!choice) return showMessage("請先選擇一位候選人。", true);
  if (!confirm("送出後不能修改，確定送出這張選票嗎？")) return;
  setBusy($("voteBtn"), true);
  try {
    await castVote({ eventId: currentEventId, candidateId: choice.value });
    $("voteForm").classList.add("hidden");
    $("voted").classList.remove("hidden");
    showMessage("投票完成。", false);
  } catch (error) {
    showMessage(readableError(error), true);
  } finally {
    setBusy($("voteBtn"), false);
  }
};

async function resumeSession(user) {
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.eventId !== currentEventId || token.claims.participantId !== participantId) return;
    startListeners("", false);
  } catch (error) {
    showMessage(readableError(error), true);
  }
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
    candidates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.order - b.order);
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
  return ({ "not-found": "活動或個人代碼不正確。", "failed-precondition": error.message, "already-exists": "你已經投過票。", "permission-denied": "你沒有執行此操作的權限。", unauthenticated: "登入狀態已失效，請重新整理。" })[code] || error?.message || "操作失敗，請稍後再試。";
}
function showMessage(text, error) { $("message").textContent = text; $("message").className = `notice ${error ? "error" : "ok"}`; }
