#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const zero = /^0+$/;
const runGit = (args, input) => execFileSync('git', args, {
  input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
});

function refsToScan(input) {
  if (process.argv.includes('--all')) return { newRefs: ['HEAD'], oldRefs: [] };
  const newRefs = [];
  const oldRefs = [];
  for (const line of input.trim().split('\n')) {
    if (!line) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error('Unexpected pre-push ref update.');
    const [, localOid, , remoteOid] = fields;
    if (zero.test(localOid)) continue; // A deletion sends no objects.
    newRefs.push(localOid);
    if (!zero.test(remoteOid)) {
      try {
        runGit(['cat-file', '-e', `${remoteOid}^{commit}`]);
        oldRefs.push(remoteOid);
      } catch {
        // A remote commit absent locally cannot be used as an exclusion.
      }
    }
  }
  return { newRefs, oldRefs };
}

const specific = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Stripe live key', /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['credentialed URL', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`<>]{12,}/gi],
];
const assignment = /\b([A-Za-z_][A-Za-z0-9_-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY))\b\s*[=:]\s*(?:["'`]([^"'`\r\n]+)["'`]|([^\s,;})]+))/gi;
const quotedToken = /["'`]([A-Za-z0-9_+/-]{28,})["'`]/g;
const entropy = value => {
  const frequencies = new Map();
  for (const char of value) frequencies.set(char, (frequencies.get(char) || 0) + 1);
  return [...frequencies.values()].reduce((sum, count) => {
    const p = count / value.length;
    return sum - p * Math.log2(p);
  }, 0);
};
const isPlaceholder = value => /^(?:process\.|import\.meta|\$|\{|<|REPLACE|YOUR_|EXAMPLE|DUMMY|TEST_|undefined|null)/i.test(value);
const isPublicKey = (name, value) => /(?:PUBLIC|PUBLISHABLE|ANON)/i.test(name) || value.startsWith('sb_publishable_');

function scanBlob(buffer, path) {
  const findings = [];
  // Text matching also works on binaries, but line numbers in binaries are not meaningful.
  const binary = buffer.subarray(0, 8192).includes(0);
  const text = buffer.toString('utf8');
  const lineAt = index => binary ? null : text.slice(0, index).split('\n').length;
  for (const [kind, pattern] of specific) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ kind, line: lineAt(match.index) });
  }
  if (binary) return findings;
  if (!path.includes('/vendor/')) {
    for (const match of text.matchAll(assignment)) {
      const [, name, quoted, bare] = match;
      const value = quoted || bare;
      const literal = Boolean(quoted) || /(?:^|\/)\.env(?:\.|$)/.test(path);
      const credentialLike = value.length >= 12 && entropy(value) >= 3.3;
      if (!isPublicKey(name, value) && !isPlaceholder(value) && literal && credentialLike) {
        findings.push({ kind: 'hard-coded credential', line: lineAt(match.index) });
      }
    }
  }
  if (!path.includes('/vendor/') && !path.endsWith('.min.js')) {
    for (const match of text.matchAll(quotedToken)) {
      const value = match[1];
      if (value.startsWith('sb_publishable_')) continue;
      if (/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) &&
          entropy(value) >= 4.1) {
        findings.push({ kind: 'high-entropy literal', line: lineAt(match.index) });
      }
    }
  }
  return findings;
}

try {
  const { newRefs, oldRefs } = refsToScan(readFileSync(0, 'utf8'));
  if (!newRefs.length) process.exit(0);
  const args = ['rev-list', '--objects', ...newRefs];
  if (oldRefs.length) args.push('--not', ...oldRefs);
  const objects = runGit(args).trim().split('\n').filter(Boolean);
  const paths = new Map(objects.map(line => {
    const space = line.indexOf(' ');
    return [space < 0 ? line : line.slice(0, space), space < 0 ? '(unknown path)' : line.slice(space + 1)];
  }));
  if (!paths.size) process.exit(0);
  const data = execFileSync('git', ['cat-file', '--batch'], {
    input: `${[...paths.keys()].join('\n')}\n`, maxBuffer: 512 * 1024 * 1024,
  });
  const findings = [];
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf(10, offset);
    const [oid, type, sizeText] = data.subarray(offset, end).toString().split(' ');
    if (!oid || !type || !sizeText) throw new Error('Could not parse git object stream.');
    const size = Number(sizeText);
    const start = end + 1;
    if (type === 'blob') {
      const path = paths.get(oid);
      for (const finding of scanBlob(data.subarray(start, start + size), path)) {
        findings.push({ path, ...finding });
      }
    }
    offset = start + size + 1;
  }
  if (findings.length) {
    console.error(`Push blocked: ${findings.length} possible secret(s) in outgoing Git objects:`);
    for (const { path, kind, line } of findings.slice(0, 30)) {
      console.error(`  ${path}${line === null ? '' : `:${line}`} — ${kind}`);
    }
    if (findings.length > 30) console.error(`  ...and ${findings.length - 30} more`);
    console.error('Remove the value from the outgoing commit history before pushing. No values are printed.');
    process.exitCode = 1;
  } else {
    console.log(`Secret scan passed (${paths.size} outgoing Git objects checked).`);
  }
} catch (error) {
  console.error(`Secret scan could not complete: ${error.message}`);
  process.exitCode = 1;
}
