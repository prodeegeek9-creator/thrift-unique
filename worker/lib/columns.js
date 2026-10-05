// The columns the Worker reads from each table, by name.
//
// Never `select=*`, here any more than in the browser (README, "The data
// layer"). The Worker reads under the service key, so a star is not a leak
// today, but it is a promise about the future nobody made: a column added
// later, a provider token or an internal note, would be pulled into memory,
// and into whatever a route hands back, without anyone deciding it should.
// Adding a column to a list below is that decision.
const cols = (...names) => names.join(',');

export const COLUMNS = {
  // Who is behind an account, for the operator's console (migration 0037).
  account_profile: cols('user_id', 'full_name', 'phone', 'address', 'city', 'state', 'updated_at'),

  // Includes the card's Paystack authorization: what an automatic renewal is
  // charged with (lib/billing.js). Only ever read to charge it.
  billing_card: cols('tenant_id', 'authorization_code', 'email', 'card_brand', 'card_last4', 'exp_month', 'exp_year', 'updated_at'),

  cart: cols('id', 'tenant_id', 'buyer_id', 'chat_id', 'payment_ref', 'amount', 'status', 'buyer_name', 'delivery_address', 'created_at', 'paid_at'),

  consignor_account: cols(
    'tenant_id', 'seller_chat_id', 'bank_code', 'bank_name', 'account_number', 'account_name', 'anchor_name', 'created_at', 'updated_at'
  ),

  consignor_account_change: cols(
    'id', 'tenant_id', 'seller_chat_id', 'bank_code', 'bank_name', 'account_number', 'account_name', 'old_bank_name',
    'old_account_number', 'requested_at', 'verify_sent_at', 'verified_at', 'store_decision', 'decided_by', 'decided_at',
    'status', 'applied_at'
  ),

  order: cols(
    'id', 'tenant_id', 'order_code', 'product_id', 'buyer_id', 'quantity', 'amount', 'commission', 'status', 'escrow_status',
    'source_channel', 'payment_ref', 'paid_at', 'shipped_at', 'confirm_deadline', 'confirmed_at', 'completed_at',
    'created_at', 'updated_at', 'delivery_address', 'buyer_note', 'cart_id', 'checkout_url'
  ),

  payout: cols(
    'id', 'tenant_id', 'amount', 'commission', 'status', 'reference', 'failure_reason', 'paid_at', 'created_at',
    'transfer_code', 'sent_at', 'attempts'
  ),

  plan_invoice: cols(
    'id', 'tenant_id', 'tier', 'amount', 'period_start', 'period_end', 'status', 'payment_ref', 'paid_at', 'paid_via',
    'reminder_stage', 'created_at', 'kind', 'from_tier'
  ),

  reconciliation_run: cols(
    'id', 'ran_at', 'window_from', 'window_to', 'payments', 'transfers', 'settled_late', 'payouts_updated', 'problems', 'error'
  ),

  refund: cols(
    'id', 'tenant_id', 'order_id', 'amount', 'reason', 'status', 'paystack_refund_id', 'failure_reason', 'requested_by',
    'requested_via', 'created_at', 'processed_at', 'paid', 'fee', 'platform_fee'
  ),

  submission: cols(
    'id', 'tenant_id', 'seller_chat_id', 'seller_phone', 'seller_name', 'title', 'asking_price', 'condition', 'images',
    'status', 'decline_reason', 'product_id', 'decided_by', 'decided_at', 'created_at', 'sold_at', 'owed_amount',
    'consignor_paid_at', 'consignor_paid_by', 'consignor_paid_note'
  ),

  // For the console's look inside a store (routes/admin.js).
  tenant: cols(
    'id', 'slug', 'name', 'tier', 'status', 'logo_url', 'brand_color', 'whatsapp_number', 'waha_session', 'commission_pct',
    'paystack_subaccount', 'disclaimer_accepted_at', 'disclaimer_version', 'created_at', 'waha_status', 'store_type',
    'category', 'payouts_paused', 'billing_status', 'paid_until', 'plan_price', 'auto_renew', 'next_tier', 'next_tier_at'
  ),

  webhook_activity: cols('session', 'last_event_at', 'last_message_at', 'last_status'),
};
