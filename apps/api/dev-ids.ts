// Fixed ids of the local database and the local denylist: `cf dev` names its local D1 and KV by the binding's `id`, and
// `cf d1 migrations apply --local` and the owner's script (scripts/invite.ts) need the same ones. Only the development mode uses them.
export const DEV_DB_ID = '6a1c0e5b-3d6f-4f6e-9a57-2c1f8b7d4e90';
export const DEV_KV_ID = '0b7d9c2e1f4a4c3b8e6d5a9f7c1e3b24';
