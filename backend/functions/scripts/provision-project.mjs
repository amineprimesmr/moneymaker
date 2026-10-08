// Server-side provisioning (operator only, uses gcloud Application Default Credentials):
//   GOOGLE_CLOUD_PROJECT=moneymaker-io node scripts/provision-project.mjs config.json owner@email
// The project is attached to the owner on their first sign-in with a verified email.
import { readFileSync } from "node:fs";
const { db, createProject, getProject } = await import("../lib/store.js");
const { FieldValue } = await import("firebase-admin/firestore");
const [file, email] = process.argv.slice(2);
if (!file || !email) { console.error("usage: provision-project.mjs config.json owner@email"); process.exit(2); }
const { name, config } = JSON.parse(readFileSync(file, "utf8"));
const created = await createProject(name, "__pending__");
await db.doc(`projects/${created.projectId}`).update({
  config: { ...(await getProject(created.projectId)).config, ...config },
  members: FieldValue.arrayRemove("__pending__"), ownerUid: null, pendingOwnerEmail: email.toLowerCase(),
});
console.log(JSON.stringify(created, null, 2));
