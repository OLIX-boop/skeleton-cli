/**
 * Best-effort secret redaction. Packed output is usually pasted into a third-party LLM, so
 * credentials that slipped into source files are masked before they leave the machine.
 */

export interface SecretRule {
  id: string;
  /** Pattern with the `g` flag. If it has a capture group named `secret`, only that part is masked. */
  pattern: RegExp;
  /** Extra check on the matched secret (e.g. entropy), to avoid masking placeholders. */
  accept?: (secret: string) => boolean;
}

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const PLACEHOLDER = /^(x+|\*+|\.+|changeme|change_me|password|secret|example|dummy|test|null|none|todo|redacted|your[-_ ].*|<.*>|\$\{.*\}|\{\{.*\}\}|%\(.*\)s|process\.env.*|os\.environ.*)$/i;

/** Looks like a real credential rather than a placeholder or an identifier. */
function credentialLike(value: string): boolean {
  if (value.length < 8 || PLACEHOLDER.test(value)) return false;
  if (/^[a-z_.-]+$/i.test(value)) return false; // an identifier or plain word
  return entropy(value) >= 3 || (/\d/.test(value) && /[a-z]/i.test(value));
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    pattern: /-----BEGIN ((?:[A-Z]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END \1PRIVATE KEY\2-----/g,
  },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    id: 'aws-secret-key',
    pattern: /aws.{0,20}?(?:secret|key).{0,20}?[:=]\s*["']?(?<secret>[A-Za-z0-9/+=]{40})\b/gi,
  },
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { id: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { id: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'pypi-token', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g },
  { id: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'twilio-key', pattern: /\bSK[0-9a-f]{32}\b/g },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/"'`]{1,64}:(?<secret>[^\s@/"'`]{3,128})@[^\s/"'`]+/gi,
    accept: (s) => !PLACEHOLDER.test(s) && !/^\$|^\{/.test(s),
  },
  {
    id: 'assigned-secret',
    pattern:
      /\b(?:password|passwd|pwd|secret|secret[_-]?key|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*(?:[:=]|=>|:=)\s*["'`](?<secret>[^"'`\s]{8,200})["'`]/gi,
    accept: credentialLike,
  },
];

export interface RedactionHit {
  rule: string;
  /** 1-based line of the match. */
  line: number;
}

export interface RedactionResult {
  content: string;
  hits: RedactionHit[];
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Mask secrets in `content`, returning the masked text and what was found. */
export function redactSecrets(content: string, rules: readonly SecretRule[] = SECRET_RULES): RedactionResult {
  const spans: { start: number; end: number; rule: string }[] = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      const secret = match.groups?.secret;
      let start = match.index;
      let end = start + match[0].length;
      if (secret !== undefined) {
        start += match[0].lastIndexOf(secret);
        end = start + secret.length;
      }
      if (rule.accept && !rule.accept(secret ?? match[0])) continue;
      spans.push({ start, end, rule: rule.id });
    }
  }
  if (!spans.length) return { content, hits: [] };

  // Earliest and then longest span wins; drop spans overlapping an accepted one.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  const hits: RedactionHit[] = [];
  for (const span of spans) {
    if (span.start < cursor) continue;
    out += content.slice(cursor, span.start) + `[REDACTED:${span.rule}]`;
    hits.push({ rule: span.rule, line: lineAt(content, span.start) });
    cursor = span.end;
  }
  return { content: out + content.slice(cursor), hits };
}
