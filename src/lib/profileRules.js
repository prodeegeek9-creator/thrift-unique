import { normalizeWhatsappNumber, isValidWhatsappNumber } from './phone.js';

// The rules for an account's name, phone and address (lib/profile.js). No
// build-time env here, so node:test can import it directly.

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta',
  'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina',
  'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers',
  'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

export const EMPTY_PROFILE = { full_name: '', phone: '', address: '', city: '', state: '' };

// The details as they'll be stored, or { error } worded for the person.
export function checkedProfile(form) {
  const trim = (v) => String(v ?? '').trim();
  const profile = {
    full_name: trim(form.full_name),
    phone: normalizeWhatsappNumber(form.phone),
    address: trim(form.address),
    city: trim(form.city),
    state: trim(form.state),
  };
  if (!profile.full_name) return { error: 'Enter your full name.' };
  if (!isValidWhatsappNumber(profile.phone)) {
    return { error: 'That phone number does not look right. Try it like 0803 123 4567.' };
  }
  if (!profile.address) return { error: 'Enter your address.' };
  if (!profile.city) return { error: 'Enter your town or city.' };
  if (!NIGERIAN_STATES.includes(profile.state)) return { error: 'Choose your state.' };
  return { profile };
}

// What's still to be asked for. Empty when there's nothing.
export function missingDetails(profile) {
  return ['full_name', 'phone', 'address', 'city', 'state'].filter((k) => !profile?.[k]);
}

// A Google sign-in's name, to start the form with.
export function nameFromAccount(user) {
  const meta = user?.user_metadata ?? {};
  return String(meta.full_name ?? meta.name ?? '').trim();
}
