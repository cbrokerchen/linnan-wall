# linnan-wall

Firebase Hosting site for the existing discussion wall and the new event check-in/voting flow.

## Pages

- `/` — existing discussion wall
- `/event.html?event=<event-id>` — participant check-in and voting
- `/admin.html` — event setup, participant import, candidates, status, and results

## Event flow

1. An administrator signs in with the verified bootstrap Google account.
2. Create an event in `checkin` status, add candidates, and import `name,access-code` rows.
3. Participants sign in anonymously and claim their record using the event ID and an 8–32 character access code.
4. Change the event to `voting` to accept votes.
5. Change it to `closed` to stop voting, then `results` to publish aggregate totals.

Access codes are normalized to uppercase and stored only as SHA-256 hashes. Votes are processed by a callable Cloud Function transaction. Firestore stores a participant's used receipt and aggregate candidate tallies in separate collections; it does not store a participant-to-candidate mapping.

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
