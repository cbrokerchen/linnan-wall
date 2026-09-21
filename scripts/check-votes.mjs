// 檢查同文合併票數與排序（直接從 public/index.html 抽真實函式跑，避免測試跟原始碼走鐘）
// 用法：node scripts/check-votes.mjs
import fs from "node:fs";
import assert from "node:assert";

const src = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const normFn = src.match(/function norm\(s\) \{[^\n]*\}/)[0];
const block = src.slice(src.indexOf("// 同文合併累計票數"), src.indexOf("const list ="));
const tally = new Function("items", `${normFn}
${block}
return [...agg.values()].sort((a, b) => b.count - a.count || a.ts - b.ts);`);

// 1. 同文不同大小寫/空白 → 合併累計
let r = tally([
  { text: "需要更多禱告", ts: 100, count: 1 },
  { text: " 需要更多禱告 ", ts: 200, count: 3 },
  { text: "Amen", ts: 300, count: 1 },
  { text: "amen", ts: 400, count: 1 },
]);
assert.equal(r.length, 2, "同文應合併成 1 筆");
assert.equal(r[0].text, "需要更多禱告");
assert.equal(r[0].count, 4);
assert.equal(r[0].ts, 100, "時間取最早送出者");
assert.equal(r[1].count, 2);
assert.equal(r[1].ts, 300, "合併後保留最早送出的時間");

// 1b. 同票數 → 早送出者在前
r = tally([
  { text: "晚", ts: 50, count: 2 },
  { text: "早", ts: 10, count: 2 },
]);
assert.deepEqual(r.map(x => x.text), ["早", "晚"]);

// 2. 舊資料沒有 count 欄位 → 視為 1 票
r = tally([{ text: "a", ts: 2 }, { text: "a", ts: 1 }, { text: "b", ts: 3 }]);
assert.equal(r[0].count, 2);
assert.equal(r[0].ts, 1);
assert.equal(r[1].count, 1);

// 3. 空字串/空白不進榜
r = tally([{ text: "   ", ts: 1 }, { text: "x", ts: 2 }]);
assert.equal(r.length, 1);
assert.equal(r[0].text, "x");

// 4. 票數高者在前
r = tally([
  { text: "少", ts: 1, count: 1 },
  { text: "多", ts: 9, count: 5 },
  { text: "中", ts: 5, count: 3 },
]);
assert.deepEqual(r.map(x => x.text), ["多", "中", "少"]);

console.log("check-votes: all assertions passed");
