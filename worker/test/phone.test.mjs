import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWhatsappNumber,
  isValidWhatsappNumber,
  checkedWhatsappNumber,
  InputError,
} from '../../src/lib/phone.js';

// The store's WhatsApp number, as Settings saves it. The bot matches it digit
// for digit against the sender, so every way a seller might type it has to
// land on the same string.

test('the ways a seller types a number all save the same digits', () => {
  for (const typed of ['2348012345678', '+234 801 234 5678', '08012345678', '0801-234-5678', '002348012345678']) {
    assert.equal(normalizeWhatsappNumber(typed), '2348012345678', typed);
  }
  assert.equal(normalizeWhatsappNumber(''), null);
  assert.equal(normalizeWhatsappNumber('   '), null);
  assert.equal(normalizeWhatsappNumber(null), null);
});

test('only plausible international numbers are accepted', () => {
  assert.ok(isValidWhatsappNumber('2348012345678'));
  assert.ok(isValidWhatsappNumber('14155552671'));
  assert.ok(!isValidWhatsappNumber('12345'));
  assert.ok(!isValidWhatsappNumber('0123456789012'));
  assert.ok(!isValidWhatsappNumber('1234567890123456'));
});

test('an unusable number is refused in words a seller can act on', () => {
  assert.throws(() => checkedWhatsappNumber('12345', '2348154765611'), InputError);
  // The bot's own number can never identify a store: WhatsApp marks what that
  // account sends as the bot's own messages, which the Worker ignores.
  assert.throws(() => checkedWhatsappNumber('0815 476 5611', '2348154765611'), /bot's number/);
  assert.equal(checkedWhatsappNumber('0801 234 5678', '2348154765611'), '2348012345678');
  assert.equal(checkedWhatsappNumber('', '2348154765611'), null);
});
