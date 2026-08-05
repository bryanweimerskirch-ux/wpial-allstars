# Test harness (not deployed — for re-running verification locally)

Requires Node 20+, Java 17+ (for the RTDB emulator), and:
    npm install firebase-tools@13 @firebase/rules-unit-testing@3 firebase@10 playwright

1. Start emulators from this folder:  npx firebase emulators:start --only database,auth --project wpial-allstars
2. Rules + race suite (28 checks):    node rules.test.js
3. Browser end-to-end (28 checks):    node smoke.test.js
   (smoke.test.js expects the repo at /home/claude/wpial-allstars and a
   Playwright chromium; adjust SITE and executablePath at the top.)
