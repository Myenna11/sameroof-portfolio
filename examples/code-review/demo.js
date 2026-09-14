#!/usr/bin/env node
// Same Roof — Code Review Demo
// Shows two agents from different providers reviewing the same code.
//
// Usage:
//   node demo.js                    # runs with mock output (no API keys needed)
//   node demo.js --live             # runs against real APIs (needs credentials in broker)
//
// What this demonstrates:
//   1. User dispatches code to logic-reviewer (Claude, expensive)
//   2. logic-reviewer analyzes logic/architecture, posts review
//   3. logic-reviewer dispatches to security-scanner (GLM, cheap) 
//   4. security-scanner checks for vulnerabilities, posts findings
//   5. Both reviews visible to human through coordinator
//
// Key points for interviews:
//   - Two different providers, isolated credentials
//   - Expensive model for judgment, cheap model for scanning
//   - Agents communicate through the coordinator, not directly
//   - All execution sandboxed (read-only in this demo)

'use strict';
const fs = require('fs');
const path = require('path');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'sample-code', 'auth.js'), 'utf8');

// ---- Mock mode: simulate the full flow without real APIs ----
function runMock() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Same Roof · Code Review Demo (mock)     ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  console.log('📄 Code submitted for review: auth.js (%d lines)\n', SAMPLE.split('\n').length);
  console.log('─'.repeat(50));

  // Step 1: Dispatch to logic-reviewer
  console.log('\n👤 human → coordinator: /dispatch');
  console.log('   to: logic-reviewer');
  console.log('   task: "Review auth.js for logic and architecture issues"');
  console.log('   ✅ task_abc123 created, assigned to logic-reviewer\n');

  sleep(800);

  // Step 2: logic-reviewer wakes up and reviews
  console.log('─'.repeat(50));
  console.log('🤖 logic-reviewer (Claude Sonnet · capable-model)\n');
  sleep(400);
  console.log(`   Review of auth.js:

   🔴 CRITICAL: SQL Injection (lines 12-13)
      String interpolation in SQL query. Use parameterized queries.
   
   🔴 CRITICAL: Password returned in response (line 31)
      user[0] includes password hash. Select only needed fields.
   
   🟡 WARNING: Weak token generation (lines 20-22)
      HMAC of username only — no expiry, no session binding.
      Use JWT with exp claim or a session store.
   
   🟡 WARNING: resetPassword uses GET (line 35)
      State-changing operation should be POST/PUT.
   
   🟢 SUGGESTION: Extract auth logic into a service layer.
      Controller should not contain business logic directly.
`);

  sleep(600);

  // Step 3: logic-reviewer dispatches to security-scanner
  console.log('   📋 logic-reviewer → coordinator: /dispatch');
  console.log('   to: security-scanner');
  console.log('   task: "Check auth.js for security vulnerabilities"');
  console.log('   ✅ task_def456 created, assigned to security-scanner\n');

  sleep(800);

  // Step 4: security-scanner wakes up
  console.log('─'.repeat(50));
  console.log('🤖 security-scanner (GLM-4-Flash · cheap-model)\n');
  sleep(400);
  console.log(`   Security scan of auth.js:

   CRITICAL: SQL Injection — lines 12-13
     Vectors: username, password fields directly interpolated.
     Fix: db.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password])

   CRITICAL: Hardcoded secret — line 5
     'supersecret123' in source code.
     Fix: Move to environment variable, rotate immediately.

   HIGH: Cookie without security flags — line 25
     Missing: httpOnly, secure, sameSite.
     Fix: res.cookie('session', token, { httpOnly: true, secure: true, sameSite: 'strict' })

   HIGH: Password in reset response — line 40
     newPassword returned in JSON body. Attackable via logs/proxy.
     Fix: Send password via email only, never in HTTP response.

   MEDIUM: Weak randomness — line 37
     Math.random() is not cryptographically secure.
     Fix: crypto.randomBytes(16).toString('hex')

   LOW: No rate limiting on login or reset endpoints.
`);

  sleep(400);

  // Step 5: Summary
  console.log('─'.repeat(50));
  console.log('\n📊 Review complete\n');
  console.log('   logic-reviewer  (Claude Sonnet)  → 2 critical, 2 warnings, 1 suggestion');
  console.log('   security-scanner (GLM-4-Flash)   → 2 critical, 2 high, 1 medium, 1 low');
  console.log('   Credential isolation: ✅  (each agent used separate provider token)');
  console.log('   Sandbox: ✅  (read-only, no exec)');
  console.log('   Cost: Claude ~$0.003 + GLM ~$0.0002 = ~$0.0032 total\n');

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Two providers. Two agents. One workspace.  ║');
  console.log('║  Credentials isolated. Execution sandboxed. ║');
  console.log('║  Collaboration defined by config, not code. ║');
  console.log('╚══════════════════════════════════════════════╝');
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}  // blocking sleep for demo effect
}

if (process.argv.includes('--live')) {
  console.log('Live mode not yet wired — run without --live for the demo flow.');
  console.log('(Live mode will use real broker credentials and coordinator.)');
  process.exit(0);
}

runMock();
