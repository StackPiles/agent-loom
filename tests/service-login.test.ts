import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeServiceLoginUrl, resolveServiceLogin } from '../src/shared/service-login.js';

test('verified Google and Japanese Amazon entries use their exact authentication origins', () => {
  assert.deepEqual(resolveServiceLogin('https://mail.google.com/mail/u/1/#inbox'), {
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=mail',
    credentialOrigin: 'https://accounts.google.com',
    provider: 'google',
  });
  assert.deepEqual(resolveServiceLogin('https://affiliate.amazon.co.jp/home'), {
    loginUrl: 'https://affiliate.amazon.co.jp/login',
    credentialOrigin: 'https://www.amazon.co.jp',
    provider: 'amazon-jp',
  });
  for (const [loginUrl, origin, provider] of [
    ['https://accounts.google.com/ServiceLogin', 'https://accounts.google.com', 'google'],
    ['https://www.amazon.co.jp/ap/signin', 'https://www.amazon.co.jp', 'amazon-jp'],
  ])
    assert.deepEqual(resolveServiceLogin(loginUrl), {
      loginUrl,
      credentialOrigin: origin,
      provider,
    });
});

test('custom login entries stay independent from the working URL and keep official redirect entries', () => {
  assert.deepEqual(
    resolveServiceLogin('https://work.example/new', 'https://identity.example/login'),
    {
      loginUrl: 'https://identity.example/login',
      credentialOrigin: 'https://identity.example',
      provider: 'custom',
    },
  );
  assert.deepEqual(
    resolveServiceLogin(
      'https://work.example/#access_token=legacy',
      'https://identity.example/login',
    ),
    {
      loginUrl: 'https://identity.example/login',
      credentialOrigin: 'https://identity.example',
      provider: 'custom',
    },
  );
  assert.deepEqual(
    resolveServiceLogin(
      'https://affiliate.amazon.co.jp/home',
      'https://affiliate.amazon.co.jp/login',
    ),
    {
      loginUrl: 'https://affiliate.amazon.co.jp/login',
      credentialOrigin: 'https://www.amazon.co.jp',
      provider: 'amazon-jp',
    },
  );
  assert.deepEqual(
    resolveServiceLogin('https://mail.google.com/', 'https://identity.example/custom'),
    {
      loginUrl: 'https://identity.example/custom',
      credentialOrigin: 'https://identity.example',
      provider: 'custom',
    },
  );
});

test('lookalike, suffix, downgraded and nonstandard-port URLs never gain a provider credential origin', () => {
  for (const url of [
    'https://mail.google.com.untrusted.example/login',
    'https://untrusted.example/?next=https://accounts.google.com',
    'https://accounts.google.com.untrusted.example/',
    'https://affiliate.amazon.co.jp.untrusted.example/',
    'https://www.amazon.co.jp.untrusted.example/',
    'https://mail.google.com:8443/',
    'https://accounts.google.com:444/',
    'https://affiliate.amazon.co.jp:8443/',
    'https://www.amazon.co.jp:444/',
    'http://mail.google.com/',
    'http://affiliate.amazon.co.jp/',
    'https://mail.google.com./',
    'https://affiliate.amazon.com/',
  ]) {
    const result = resolveServiceLogin(url);
    assert.equal(result.provider, 'custom', url);
    assert.equal(result.credentialOrigin, new URL(url).origin);
  }
});

test('URL parsing normalizes canonical origins but never includes rejected values in errors', () => {
  assert.equal(
    normalizeServiceLoginUrl(' https://MAIL.GOOGLE.COM:443/inbox '),
    'https://mail.google.com/inbox',
  );
  assert.equal(resolveServiceLogin('https://MAIL.GOOGLE.COM:443/inbox').provider, 'google');
  assert.equal(resolveServiceLogin('https://mail.google.com/#search/token').provider, 'google');
  for (const value of [
    '',
    'file:///private',
    'https://user:fixture-secret-value@mail.google.com/',
    'https://accounts.google.com/?password=fixture-secret-value',
    'https://identity.example/#access_token=fixture-secret-value',
    'https://identity.example/?apiKey=fixture-secret-value',
    'https://mail.\ngoogle.com/',
    'https://identity.example/' + 'x'.repeat(2_000),
  ])
    assert.throws(() => normalizeServiceLoginUrl(value), {
      message: 'Use an HTTP(S) login URL without credentials.',
    });
});
