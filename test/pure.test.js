test('sanitizeSiteInput: selector ze zabronionym znakiem -> invalidSelector', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', selector: 'a;b' });
  assert.deepEqual(s, { invalidSelector: true });
});

test('sanitizeSiteInput: selector ponad 200 znakow -> invalidSelector', () => {
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', selector: 'a'.repeat(201) });
  assert.deepEqual(s, { invalidSelector: true });
});

test('sanitizeSiteInput: selector z literami unicode dozwolony', () => {
  const sel = '.cz' + '\u0119' + '\u015b' + '\u0107' + '-2';
  const s = sanitizeSiteInput({ name: 'T', url: 'https://example.com/', selector: sel });
  assert.ok(s && s.selector === sel);
});