import { supabase } from './supabase.js';

// A store's photo expectations (migration 0041): which categories it takes
// from people bringing it items, and which shots each one needs.
//
// Stored as differences from the platform's defaults, never as a full copy:
// setting something back to the default deletes the override, so a store
// that never touches this keeps following the defaults as they improve.

export const REQUIREMENT_LABELS = {
  required: 'Required',
  optional: 'Optional',
  conditional: 'When it applies',
  off: 'Off',
};

// What decides a conditional shot, in the words the seller was asked.
export const FLAG_HINTS = {
  has_flaws: 'if the seller says it has flaws',
  is_phone: 'if the seller says it is a phone',
  packaged: 'if the seller says it is packaged',
};

// What a shot may be set to, given the rule underneath. Mirrors
// trg_check_store_shot_rule() in 0041, which refuses anything else: the main
// shot is fixed, and a shot that depends on a question can only be on or off.
export function choicesFor(rule) {
  if (rule.is_main) return [];
  if (rule.requirement === 'conditional') return ['conditional', 'off'];
  return ['required', 'optional', 'off'];
}

export async function fetchPhotoSettings(tenantId) {
  if (!tenantId) return [];

  const [categories, rules, declined, overrides] = await Promise.all([
    supabase.from('photo_categories').select('slug, name').eq('active', true).order('name'),
    supabase
      .from('photo_shot_rules')
      .select('category, shot_type, label, requirement, condition_flag, is_main, sort_order')
      .order('sort_order'),
    supabase.from('store_photo_categories').select('category').eq('tenant_id', tenantId),
    supabase.from('store_shot_rules').select('category, shot_type, requirement').eq('tenant_id', tenantId),
  ]);
  for (const r of [categories, rules, declined, overrides]) if (r.error) throw r.error;

  const notTaken = new Set(declined.data.map((r) => r.category));
  const mine = new Map(overrides.data.map((o) => [`${o.category}/${o.shot_type}`, o.requirement]));

  return categories.data.map((c) => ({
    slug: c.slug,
    name: c.name,
    accepted: !notTaken.has(c.slug),
    shots: rules.data
      .filter((r) => r.category === c.slug)
      .map((r) => ({
        shotType: r.shot_type,
        label: r.label,
        isMain: r.is_main,
        conditionFlag: r.condition_flag,
        base: r.requirement,
        requirement: mine.get(`${c.slug}/${r.shot_type}`) ?? r.requirement,
        choices: choicesFor(r),
      })),
  }));
}

export async function setCategoryAccepted(tenantId, category, accepted) {
  const { error } = accepted
    ? await supabase.from('store_photo_categories').delete().eq('tenant_id', tenantId).eq('category', category)
    : await supabase.from('store_photo_categories').upsert({ tenant_id: tenantId, category, accepted: false });
  if (error) throw error;
}

export async function setShotRequirement(tenantId, { category, shotType, base, requirement }) {
  const { error } =
    requirement === base
      ? await supabase
          .from('store_shot_rules')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('category', category)
          .eq('shot_type', shotType)
      : await supabase
          .from('store_shot_rules')
          .upsert({ tenant_id: tenantId, category, shot_type: shotType, requirement });
  if (error) throw error;
}
