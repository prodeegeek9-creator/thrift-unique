// A phone number as typed, as the digits the rest of the system stores: the
// same rules as the database trigger in migration 0016. "0803 123 4567",
// "+234 803 123 4567" and "2348031234567" are all 2348031234567.
//
// null for nothing typed; undefined for something that is not a number.
export function normalizeNumber(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = `234${digits.slice(1)}`;
  return /^[1-9][0-9]{9,14}$/.test(digits) ? digits : undefined;
}
