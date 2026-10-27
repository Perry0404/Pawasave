// 123_ajo_debt_and_rules.test.mjs — Ajo debt recovery, debtor restrictions, rules in circle chat.
//   cd supabase/tests/pglite && node 123_ajo_debt_and_rules.test.mjs
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => fs.readFileSync(path.join(HERE, '../../migrations', f), 'utf8')
const db = new PGlite()
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const one = async (s, p = []) => (await db.query(s, p)).rows[0]
const rows = async (s, p = []) => (await db.query(s, p)).rows
const val = async (s, p = []) => Object.values((await db.query(s, p)).rows[0])[0]
const throws = async (s, p, re, m) => { try { await db.query(s, p); ok(false, m + ' (did not raise)') } catch (e) { ok(re.test(e.message), m + (re.test(e.message) ? '' : ` (${e.message})`)) } }

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.platform_settings (key text primary key, value text);
INSERT INTO public.platform_settings VALUES ('esusu_strike_limit','4');
CREATE TABLE public.profiles (id uuid primary key, display_name text not null default '', tag text);
CREATE TABLE public.wallets (user_id uuid unique, usdc_balance_micro bigint not null default 0, cngn_pool_micro bigint not null default 0, updated_at timestamptz);
CREATE TABLE public.transactions (id uuid primary key default gen_random_uuid(), user_id uuid, type text, direction text,
  amount_kobo bigint, amount_usdc_micro bigint, description text, reference text unique, status text);
CREATE TABLE public.esusu_groups (id uuid primary key default gen_random_uuid(), name text, owner_id uuid, status text default 'active',
  cycle_period text default 'weekly', contribution_amount_kobo bigint default 100000, payout_mode text default 'rotating', goal_kobo bigint,
  pot_balance_kobo bigint default 0, current_cycle int default 1);
CREATE TABLE public.esusu_members (id uuid primary key default gen_random_uuid(), group_id uuid references public.esusu_groups(id), user_id uuid,
  payout_position int, missed_strikes int not null default 0, removed boolean not null default false, removed_at timestamptz,
  has_collected boolean not null default false, amount_owed_kobo bigint not null default 0);
`)
// Minimal stand-ins for 094/095 (the real ones reference p2p tables this test does not stub).
await db.exec(`
CREATE TABLE public.chat_rooms (id uuid primary key default gen_random_uuid(), kind text, circle_id uuid unique, last_seq bigint not null default 0);
CREATE TABLE public.chat_messages (id bigserial primary key, room_id uuid, seq bigint, sender_id uuid, client_id text unique, kind text, body text, metadata jsonb);
CREATE FUNCTION public.chat_room_for_circle(p uuid) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE v uuid; BEGIN
  INSERT INTO chat_rooms (kind, circle_id) VALUES ('circle', p) ON CONFLICT (circle_id) DO NOTHING RETURNING id INTO v;
  IF v IS NULL THEN SELECT id INTO v FROM chat_rooms WHERE circle_id = p; END IF; RETURN v; END $$;
CREATE FUNCTION public.chat_post_message(p_room uuid, p_sender uuid, p_client_id text, p_kind text, p_body text DEFAULT NULL, p_metadata jsonb DEFAULT NULL)
RETURNS public.chat_messages LANGUAGE plpgsql AS $$ DECLARE v_seq bigint; r public.chat_messages; BEGIN
  SELECT * INTO r FROM chat_messages WHERE client_id = p_client_id; IF FOUND THEN RETURN r; END IF;
  UPDATE chat_rooms SET last_seq = last_seq + 1 WHERE id = p_room RETURNING last_seq INTO v_seq;
  INSERT INTO chat_messages (room_id, seq, sender_id, client_id, kind, body, metadata) VALUES (p_room, v_seq, p_sender, p_client_id, p_kind, p_body, p_metadata) RETURNING * INTO r;
  RETURN r; END $$;
`)
const M = read('123_ajo_debt_and_rules.sql')
await db.exec(M); await db.exec(M)
console.log('migrations applied (123 twice)')

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
const [ADA, BAYO, CHI, DEBTOR] = [1, 2, 3, 4].map(U)
for (const [u, n] of [[ADA, 'Ada'], [BAYO, 'Bayo'], [CHI, 'Chi'], [DEBTOR, 'Dayo']]) {
  await db.query('insert into profiles (id, display_name) values ($1,$2)', [u, n])
  await db.query('insert into wallets (user_id) values ($1)', [u])
}
const chat = async (g) => (await rows(`select m.body from chat_messages m join chat_rooms r on r.id = m.room_id where r.circle_id = $1 and m.kind = 'system' order by m.seq`, [g])).map((r) => r.body)

// ── rules on create and join ──
const G = (await one(`insert into esusu_groups (name, owner_id) values ('Market line', $1) returning id`, [ADA])).id
let msgs = await chat(G)
ok(msgs.length === 1 && /Welcome to "Market line"/.test(msgs[0]) && /Rules of this circle/.test(msgs[0]) && /4 missed cycles/.test(msgs[0]),
  'creating a circle posts its rules (with the 4-strike limit) to the circle chat')
const mA = (await one('insert into esusu_members (group_id, user_id, payout_position) values ($1,$2,1) returning id', [G, ADA])).id
const mB = (await one('insert into esusu_members (group_id, user_id, payout_position) values ($1,$2,2) returning id', [G, BAYO])).id
const mD = (await one('insert into esusu_members (group_id, user_id, payout_position, has_collected) values ($1,$2,3,true) returning id', [G, DEBTOR])).id
msgs = await chat(G)
ok(msgs.some((b) => /^Bayo joined the circle/.test(b) && /Rules of this circle/.test(b)), 'someone joining gets a welcome with the rules')

// ── strike + removal messages ──
await db.query('update esusu_members set missed_strikes = 1 where id = $1', [mD])
ok((await chat(G)).some((b) => /Dayo missed a contribution \(strike 1 of 4\)/.test(b)), 'a missed cycle is posted (strike 1 of 4)')

// Removed owing ₦2,000 with ₦500 in the wallet: ₦500 collected at once into the pot.
await db.query('update wallets set usdc_balance_micro = 500000000 where user_id = $1', [DEBTOR])
await db.query(`update esusu_members set removed = true, removed_at = now(), missed_strikes = 4, amount_owed_kobo = 200000 where id = $1`, [mD])
msgs = await chat(G)
ok(msgs.some((b) => /Dayo was removed .* 4 missed contributions/.test(b) && /still owe ₦2,000\.00/.test(b)), 'the removal is posted, with what they owe')
ok(Number(await val('select usdc_balance_micro from wallets where user_id = $1', [DEBTOR])) === 0, 'whatever the debtor had (₦500) is taken at once')
ok(Number(await val('select amount_owed_kobo from esusu_members where id = $1', [mD])) === 150000, 'their debt drops to ₦1,500')
ok(Number(await val('select pot_balance_kobo from esusu_groups where id = $1', [G])) === 50000, 'and the ₦500 goes into the circle pot')
ok(msgs.some((b) => /₦500\.00 of Dayo's unpaid contributions was recovered/.test(b)), 'the recovery is posted to the circle')

// ── restrictions while owing ──
await throws(`insert into esusu_members (group_id, user_id, payout_position) values ($1,$2,9)`, [G, DEBTOR], /owe ₦1,500\.00 to a circle/, 'a debtor cannot join a circle')
await throws(`insert into esusu_groups (name, owner_id) values ('Mine', $1)`, [DEBTOR], /owe ₦1,500\.00/, 'or create one')
ok(Number(await val('select ajo_debt_owed_kobo($1)', [DEBTOR])) === 150000, 'ajo_debt_owed_kobo reports ₦1,500 for the API guards')

// ── a later deposit clears the rest ──
await db.query('update wallets set usdc_balance_micro = usdc_balance_micro + 5000000000 where user_id = $1', [DEBTOR]) // ₦5,000 arrives
ok(Number(await val('select amount_owed_kobo from esusu_members where id = $1', [mD])) === 0, 'a deposit pays the remaining ₦1,500 automatically')
ok(Number(await val('select usdc_balance_micro from wallets where user_id = $1', [DEBTOR])) === 3500000000, 'and the debtor keeps the other ₦3,500')
ok(Number(await val('select pot_balance_kobo from esusu_groups where id = $1', [G])) === 200000, 'the pot now has the full ₦2,000 back')
ok(Number(await val('select ajo_debt_owed_kobo($1)', [DEBTOR])) === 0, 'debt cleared, so restrictions lift')

// ── finished circle: recovered money is shared between members who stayed ──
const G2 = (await one(`insert into esusu_groups (name, owner_id, status) values ('Old circle', $1, 'active') returning id`, [BAYO])).id
await db.query('insert into esusu_members (group_id, user_id, payout_position) values ($1,$2,1),($1,$3,2)', [G2, BAYO, CHI])
const mD2 = (await one('insert into esusu_members (group_id, user_id, payout_position, has_collected) values ($1,$2,3,true) returning id', [G2, DEBTOR])).id
await db.query(`update esusu_groups set status = 'completed' where id = $1`, [G2])
ok((await chat(G2)).some((b) => /This circle is complete/.test(b)), 'completing a circle posts a closing message')
await db.query('update wallets set usdc_balance_micro = 0 where user_id = $1', [DEBTOR])
await db.query(`update esusu_members set removed = true, removed_at = now(), amount_owed_kobo = 100000 where id = $1`, [mD2])
await db.query('update wallets set usdc_balance_micro = 1000000000 where user_id = $1', [DEBTOR]) // ₦1,000 arrives
const bay = Number(await val('select usdc_balance_micro from wallets where user_id = $1', [BAYO]))
const chi = Number(await val('select usdc_balance_micro from wallets where user_id = $1', [CHI]))
ok(bay === 500000000 && chi === 500000000, 'in a finished circle the ₦1,000 recovered is shared ₦500 / ₦500 between the members who stayed')

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
