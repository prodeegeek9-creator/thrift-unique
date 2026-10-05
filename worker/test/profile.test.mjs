import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NIGERIAN_STATES,
  checkedProfile,
  missingDetails,
  nameFromAccount,
} from '../../src/lib/profileRules.js';

const FILLED = {
  full_name: '  Ada Obi ',
  phone: '0803 123 4567',
  address: ' 12 Allen Ave ',
  city: 'Ikeja',
  state: 'Lagos',
};

test('the details are stored tidy, with the phone as the digits everything else uses', () => {
  assert.deepEqual(checkedProfile(FILLED).profile, {
    full_name: 'Ada Obi',
    phone: '2348031234567',
    address: '12 Allen Ave',
    city: 'Ikeja',
    state: 'Lagos',
  });
});

test('every detail is asked for, and a phone that is not a number is refused', () => {
  for (const key of ['full_name', 'phone', 'address', 'city', 'state']) {
    const { error, profile } = checkedProfile({ ...FILLED, [key]: '   ' });
    assert.ok(error, `${key} left blank got through`);
    assert.equal(profile, undefined);
  }
  assert.match(checkedProfile({ ...FILLED, phone: '12345' }).error, /phone number/);
  assert.match(checkedProfile({ ...FILLED, state: 'Atlantis' }).error, /state/);
});

test('36 states and the FCT, each short enough for the column', () => {
  assert.equal(NIGERIAN_STATES.length, 37);
  assert.equal(new Set(NIGERIAN_STATES).size, 37);
  for (const s of NIGERIAN_STATES) assert.ok(s.length <= 40);
});

test('what is still to be asked for', () => {
  assert.deepEqual(missingDetails(null), ['full_name', 'phone', 'address', 'city', 'state']);
  assert.deepEqual(missingDetails({ full_name: 'Google Person' }), ['phone', 'address', 'city', 'state']);
  assert.deepEqual(missingDetails(checkedProfile(FILLED).profile), []);
});

test("a Google sign-in's name starts the form", () => {
  assert.equal(nameFromAccount({ user_metadata: { full_name: 'Ada Obi' } }), 'Ada Obi');
  assert.equal(nameFromAccount({ user_metadata: { name: 'Ada' } }), 'Ada');
  assert.equal(nameFromAccount({}), '');
});
