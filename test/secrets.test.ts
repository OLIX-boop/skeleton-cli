import { describe, expect, it } from 'vitest';
import { entropy, redactSecrets } from '../src/security/secrets.js';

const fake = {
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  gh: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  anthropic: 'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  openai: 'sk-proj-' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd',
  stripe: 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc',
  google: 'AIza' + 'SyA-1234567890abcdefghijklmnopqrstu',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
};

describe('redactSecrets', () => {
  it.each([
    ['aws-access-key', `const key = "${fake.aws}";`],
    ['aws-secret-key', `aws_secret_access_key = ${fake.awsSecret}`],
    ['github-token', `token: ${fake.gh}`],
    ['anthropic-key', `ANTHROPIC_API_KEY=${fake.anthropic}`],
    ['openai-key', `client = OpenAI(api_key="${fake.openai}")`],
    ['stripe-key', `Stripe(${JSON.stringify(fake.stripe)})`],
    ['google-api-key', `key=${fake.google}`],
    ['jwt', `Authorization: Bearer ${fake.jwt}`],
  ])('masks %s', (rule, line) => {
    const out = redactSecrets(line);
    expect(out.hits.map((h) => h.rule)).toContain(rule);
    expect(out.content).toContain(`[REDACTED:`);
    for (const value of Object.values(fake)) expect(out.content).not.toContain(value);
  });

  it('masks private key blocks entirely', () => {
    const src = 'const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nabc\n-----END RSA PRIVATE KEY-----`;\n';
    const out = redactSecrets(src);
    expect(out.content).toBe('const pem = `[REDACTED:private-key]`;\n');
    expect(out.hits).toEqual([{ rule: 'private-key', line: 1 }]);
  });

  it('masks only the password in connection strings', () => {
    const out = redactSecrets('DATABASE_URL = "postgres://admin:S3cr3tP4ss@db.internal:5432/app"');
    expect(out.content).toBe('DATABASE_URL = "postgres://admin:[REDACTED:url-credentials]@db.internal:5432/app"');
  });

  it('masks assigned high-entropy secrets but not placeholders or references', () => {
    const src = [
      'password = "hunter2hunter2"',
      'api_key: "9f8e7d6c5b4a39281706f5e4d3c2b1a0"',
      'secret = "changeme"',
      'password = "${DB_PASSWORD}"',
      'apiKey = "<your-api-key>"',
      "const secret_key = 'my_secret_key_name';",
      'password = "xxxxxxxxxxxx"',
    ].join('\n');
    const out = redactSecrets(src);
    expect(out.hits.map((h) => h.line)).toEqual([1, 2]);
    expect(out.content.split('\n').slice(2)).toEqual(src.split('\n').slice(2));
  });

  it('leaves ordinary code alone', () => {
    const src = `export function login(user: string, password: string) {
  const token = await auth.createToken(user);
  const url = \`https://api.example.com/v1/users/\${user}\`;
  return { token, password: hash(password) };
}
`;
    expect(redactSecrets(src)).toEqual({ content: src, hits: [] });
  });

  it('reports line numbers', () => {
    const out = redactSecrets(`a\nb\nkey = "${fake.gh}"\n`);
    expect(out.hits).toEqual([{ rule: 'github-token', line: 3 }]);
  });
});

describe('entropy', () => {
  it('is higher for random strings', () => {
    expect(entropy('aaaaaaaa')).toBe(0);
    expect(entropy('9f8e7d6c5b4a3928')).toBeGreaterThan(3.5);
  });
});
