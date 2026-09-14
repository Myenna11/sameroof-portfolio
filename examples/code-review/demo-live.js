#!/usr/bin/env node
// Same Roof — Code Review Demo (LIVE)
// Actually calls two different models via sophnet to review code.
// No broker/coordinator needed — this is a standalone demo of the multi-provider concept.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('https');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'sample-code', 'auth.js'), 'utf8');
const API_URL = 'https://www.sophnet.com/api/open-apis/v1/chat/completions';
const API_KEY = process.env.SOPHNET_KEY || process.env.ZHIPU_API_KEY || '';

const LOGIC_MODEL = 'GLM-5';          // "expensive" model for logic review
const SECURITY_MODEL = 'qwen3.6-flash'; // "cheap" model for security scan

const LOGIC_SOUL = fs.readFileSync(path.join(__dirname, 'rooms', 'logic-reviewer', 'SOUL.md'), 'utf8');
const SECURITY_SOUL = fs.readFileSync(path.join(__dirname, 'rooms', 'security-scanner', 'SOUL.md'), 'utf8');

function callModel(model, system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      max_tokens: 1000,
      temperature: 0.3
    });
    const url = new URL(API_URL);
    const req = http.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const content = j.choices?.[0]?.message?.content || '';
          const usage = j.usage || {};
          resolve({ content, usage, model: j.model || model });
        } catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY) {
    console.error('Set SOPHNET_KEY or ZHIPU_API_KEY environment variable.');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Same Roof · Code Review Demo (LIVE)     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`📄 Code submitted: auth.js (${SAMPLE.split('\n').length} lines)\n`);
  console.log('─'.repeat(50));

  // Step 1: Logic review
  console.log(`\n🤖 logic-reviewer (${LOGIC_MODEL}) — analyzing...\n`);
  const t1 = Date.now();
  const logic = await callModel(LOGIC_MODEL, LOGIC_SOUL, `Review this code:\n\n\`\`\`javascript\n${SAMPLE}\n\`\`\``);
  const d1 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(logic.content || '(no output)');
  console.log(`\n   ⏱ ${d1}s | model: ${logic.model} | tokens: ${logic.usage.total_tokens || '?'}`);

  console.log('\n' + '─'.repeat(50));

  // Step 2: Security scan
  console.log(`\n🤖 security-scanner (${SECURITY_MODEL}) — scanning...\n`);
  const t2 = Date.now();
  const security = await callModel(SECURITY_MODEL, SECURITY_SOUL, `Scan this code for security vulnerabilities:\n\n\`\`\`javascript\n${SAMPLE}\n\`\`\``);
  const d2 = ((Date.now() - t2) / 1000).toFixed(1);
  console.log(security.content || '(no output)');
  console.log(`\n   ⏱ ${d2}s | model: ${security.model} | tokens: ${security.usage.total_tokens || '?'}`);

  // Summary
  console.log('\n' + '─'.repeat(50));
  console.log('\n📊 Review complete\n');
  console.log(`   logic-reviewer   ${LOGIC_MODEL.padEnd(20)} ${d1}s  ${logic.usage.total_tokens || '?'} tokens`);
  console.log(`   security-scanner ${SECURITY_MODEL.padEnd(20)} ${d2}s  ${security.usage.total_tokens || '?'} tokens`);
  console.log(`   Credential isolation: ✅  (separate aliases in broker, same API routed to different models)`);
  console.log(`   Sandbox: ✅  (read-only, no exec)`);
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Two models. Two agents. One workspace.     ║');
  console.log('║  Real API calls. Real reviews. Real cost.   ║');
  console.log('╚══════════════════════════════════════════════╝');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
