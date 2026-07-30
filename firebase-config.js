/* Firebase web config for the WPIAL All Stars league site.
 *
 * NOT a secret. A Firebase web apiKey identifies the project, not the caller —
 * it is designed to ship in client code. Access is controlled entirely by
 * Firebase Auth plus the Realtime Database security rules, which is why this is
 * safe in a public repo. See https://firebase.google.com/docs/projects/api-keys
 *
 * Project: wpial-allstars (project number 440172107697), Spark/no-cost plan,
 * no billing account attached. Google Analytics and Gemini both declined at
 * creation. Auth: Email link (passwordless) only. Realtime Database exists in
 * locked mode and nothing connects to it yet.
 */
window.WPIAL_FIREBASE = {
  apiKey: "AIzaSyA-dHNnIHtzUwOWU1Dqa8G5qQ-67pDgg4Y",
  authDomain: "wpial-allstars.firebaseapp.com",
  projectId: "wpial-allstars",
  storageBucket: "wpial-allstars.firebasestorage.app",
  databaseURL: "https://wpial-allstars-default-rtdb.firebaseio.com",
  messagingSenderId: "440172107697",
  appId: "1:440172107697:web:49359d082b42a1af9c0f90"
};
