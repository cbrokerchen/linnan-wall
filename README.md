# linnan-wall

Firebase Hosting site for the existing discussion wall and the new event check-in/voting flow.

## Pages

- `/` — existing discussion wall
- `/event.html` — participant check-in and voting for the single configured event
- `/admin.html` — setup, participant import, candidate churches, status, results, and discussion-wall controls for the same event

## Event flow

1. An administrator signs in with the verified bootstrap Google account.
2. Create an event in `checkin` status, add candidate churches, and import `name,church` rows.
3. Participants sign in anonymously and claim their record using their name and church. Exact duplicate name/church rows are rejected during import.
4. Staff can check in a participant from the admin roster. A participant without a smartphone can then vote personally on a shared device; shared-device mode signs out and clears their participant session after the vote.
5. Change the event to `voting` to accept votes. Participants may select a listed church or enter a missing church name; creation and voting happen atomically and no creator identity is stored.
6. Change it to `closed` to stop voting, then `results` to publish aggregate totals.

The same administrator page can switch the active discussion-wall question, show its live response count, open the projector or mobile submission view, and clear the active question after confirmation.

Name/church lookup keys are normalized and stored as SHA-256 hashes alongside the administrator-only roster fields. Votes are processed by a callable Cloud Function transaction. Firestore stores a participant's used receipt and aggregate church tallies in separate collections; it does not store a participant-to-church mapping.

## Local checks

```sh
cd functions
npm test
npm audit
cd ..
node scripts/check-votes.mjs
npx -y firebase-tools@latest deploy --only firestore:rules --dry-run --project linnan-de218
```

Firestore Emulator rule tests are available with:

```sh
npx -y firebase-tools@latest emulators:exec --only firestore "cd functions && npm run test:rules" --project linnan-de218
```

The emulator requires a local Java runtime.

## Deployment requirement

Callable Cloud Functions require the Firebase project to use the Blaze plan so Cloud Build and Artifact Registry can be enabled. Do not deploy Hosting without the Functions, Auth, and Firestore rules because the participant flow would be incomplete.
