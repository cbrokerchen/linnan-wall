const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("./index");

test("normalizes event ids and participant identity text", () => {
  assert.equal(_test.normalizedEventId(" Annual-2026 "), "annual-2026");
  assert.equal(_test.normalizedIdentityText(" 王　小明  "), "王 小明");
  assert.equal(_test.EVENT_ID_PATTERN.test("annual-2026"), true);
  assert.equal(_test.EVENT_ID_PATTERN.test("A bad id"), false);
});

test("builds a normalized name and church lookup hash", () => {
  const hash = _test.participantLookupHash("王小明", "林南教會");
  assert.equal(hash, _test.participantLookupHash(" 王小明 ", "林南教會"));
  assert.equal(hash.length, 64);
  assert.notEqual(hash, "王小明\n林南教會");
});

test("accepts only an eligible checked-in participant during voting", () => {
  assert.doesNotThrow(() => _test.validateVoteState({ event: { status: "voting" }, participant: { eligible: true, checkedInAt: new Date(), hasVoted: false }, candidate: { active: true }, receiptExists: false }));
});

test("rejects duplicate votes even when participant flag and receipt disagree", () => {
  assert.throws(() => _test.validateVoteState({ event: { status: "voting" }, participant: { eligible: true, checkedInAt: new Date(), hasVoted: true }, candidate: { active: true }, receiptExists: false }), /已經投過票/);
  assert.throws(() => _test.validateVoteState({ event: { status: "voting" }, participant: { eligible: true, checkedInAt: new Date(), hasVoted: false }, candidate: { active: true }, receiptExists: true }), /已經投過票/);
});

test("rejects voting outside the open window and inactive candidates", () => {
  const participant = { eligible: true, checkedInAt: new Date(), hasVoted: false };
  assert.throws(() => _test.validateVoteState({ event: { status: "closed" }, participant, candidate: { active: true }, receiptExists: false }), /未開放投票/);
  assert.throws(() => _test.validateVoteState({ event: { status: "voting" }, participant, candidate: { active: false }, receiptExists: false }), /候選人無效/);
});

test("permits shared-device claim during voting only after staff check-in", () => {
  assert.doesNotThrow(() => _test.validateClaimState({ status: "voting" }, { eligible: true, checkedInAt: new Date() }));
  assert.throws(() => _test.validateClaimState({ status: "voting" }, { eligible: true, checkedInAt: null }), /一般簽到已截止/);
  assert.doesNotThrow(() => _test.validateClaimState({ status: "checkin" }, { eligible: true, checkedInAt: null }));
});
