#![no_std]

//! Conduit mandate contract.
//!
//! An owner signs one mandate describing what an automation wallet may do on their behalf:
//! which assets, how much per time window, within which price bounds, and until when. The
//! automation wallet ("delegate") can then trigger swaps, but only inside those limits and
//! only through this contract.
//!
//! The important part is where the allowance goes. The owner approves *this contract* as the
//! spender on the token, never the delegate. The delegate therefore holds no spending power of
//! its own — it can ask this contract to act, and the contract refuses anything the mandate
//! does not cover. Revoking is one `revoke` call, or letting the mandate expire.
//!
//! Price bounds are enforced by the router rather than read from an oracle: a bound is
//! converted into the minimum output the swap must return, and the router reverts atomically
//! if the market cannot deliver it. The executed price is the one that is checked, so there is
//! no oracle to go stale and no spot reading to manipulate between check and swap.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    token::TokenClient, vec, Address, Env, IntoVal, Symbol, Vec,
};

/// Prices are base-asset stroops per whole unit of the traded asset. Every SAC in this
/// deployment uses Stellar's native 7-decimal precision.
const PRICE_SCALE: i128 = 10_000_000;

/// Seconds past the current ledger timestamp given to the router as a swap deadline.
const SWAP_DEADLINE_SECS: u64 = 300;

/// ~1 day of ledgers at 5s each; the threshold below which a TTL is topped up.
const TTL_THRESHOLD: u32 = 17_280;
/// ~30 days of ledgers; what a TTL is topped up to.
const TTL_EXTEND: u32 = 518_400;

/// The subset of the Soroswap router this contract calls. Verified against the deployed
/// testnet router (`stellar contract info interface`): `to` is authorised by the router and
/// acts as both payer and recipient, which is why the swap runs in this contract's own name.
#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;

    /// The pool the router will move the input to for this pair.
    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
}

#[contracttype]
#[derive(Clone)]
pub struct Mandate {
    /// The only address allowed to call `execute` for this owner.
    pub delegate: Address,
    /// Assets that may be traded against the base asset. The base asset itself is implicit.
    pub assets: Vec<Address>,
    /// Ceiling on base-asset outflow per window, in stroops.
    pub cap_per_window: i128,
    /// Length of a spending window, in ledgers.
    pub window_ledgers: u32,
    /// Buy only at or below this price, in base stroops per unit. 0 disables the bound.
    pub buy_below: i128,
    /// Sell only at or above this price, in base stroops per unit. 0 disables the bound.
    pub sell_above: i128,
    /// Last ledger on which this mandate may be used.
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Router,
    Base,
    /// Per-owner mandate. Must outlive individual calls, so it is persistent.
    Mandate(Address),
    /// Base spent by an owner inside one window. Meaningless once the window passes, so it
    /// is temporary and its TTL is the window itself.
    Spent(Address, u32),
}

/// Numbered from 100 on purpose. `execute` calls into a token contract and the router, and
/// their failures surface as `Error(Contract, #N)` too — the SAC uses single digits (#9 is an
/// exhausted allowance) and the router uses 5xx. Keeping this range clear of both means a
/// caller can tell whose rule was broken instead of guessing.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NoMandate = 100,
    Expired = 101,
    AssetNotAllowed = 102,
    CapExceeded = 103,
    InvalidAmount = 104,
    InvalidMandate = 105,
    SameAsset = 106,
    NotBaseLeg = 107,
    Overflow = 108,
}

// `owner` is a topic on every event, not just a field, so RPC can filter a wallet's own
// history server-side. Left in the data it would force each client to download everyone's
// events and sift through them.
#[contractevent(topics = ["mandate", "set"])]
pub struct MandateSet {
    #[topic]
    pub owner: Address,
    pub delegate: Address,
    pub cap_per_window: i128,
    pub expiration_ledger: u32,
}

#[contractevent(topics = ["mandate", "revoked"])]
pub struct MandateRevoked {
    #[topic]
    pub owner: Address,
}

#[contractevent(topics = ["mandate", "executed"])]
pub struct MandateExecuted {
    #[topic]
    pub owner: Address,
    pub delegate: Address,
    pub asset_in: Address,
    pub asset_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
}

#[contract]
pub struct MandateContract;

#[contractimpl]
impl MandateContract {
    /// `base` is the asset every mandate trades against — USDC in this deployment, which is
    /// also what the anchor pays out.
    pub fn __constructor(env: Env, admin: Address, router: Address, base: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Router, &router);
        env.storage().instance().set(&DataKey::Base, &base);
    }

    /// Register or replace the caller's mandate. Only the owner can do this, and it is the
    /// single moment at which the owner decides what the delegate is allowed to do.
    pub fn set_mandate(env: Env, owner: Address, mandate: Mandate) -> Result<(), Error> {
        owner.require_auth();

        if mandate.window_ledgers == 0
            || mandate.cap_per_window <= 0
            || mandate.assets.is_empty()
            || mandate.buy_below < 0
            || mandate.sell_above < 0
            || mandate.expiration_ledger <= env.ledger().sequence()
        {
            return Err(Error::InvalidMandate);
        }

        let key = DataKey::Mandate(owner.clone());
        env.storage().persistent().set(&key, &mandate);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        bump_instance(&env);

        MandateSet {
            owner,
            delegate: mandate.delegate,
            cap_per_window: mandate.cap_per_window,
            expiration_ledger: mandate.expiration_ledger,
        }
        .publish(&env);

        Ok(())
    }

    /// Cancel a mandate. Takes effect on the next ledger; nothing else is needed to stop the
    /// delegate, because the delegate never held an allowance of its own.
    pub fn revoke(env: Env, owner: Address) {
        owner.require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Mandate(owner.clone()));
        MandateRevoked { owner }.publish(&env);
    }

    /// Swap on the owner's behalf, inside the mandate. Called by the delegate, never by the
    /// owner: the owner's signature was spent once, on `set_mandate`.
    ///
    /// Returns the amount of `asset_out` delivered to the owner.
    pub fn execute(
        env: Env,
        owner: Address,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        amount_out_min: i128,
    ) -> Result<i128, Error> {
        if amount_in <= 0 || amount_out_min < 0 {
            return Err(Error::InvalidAmount);
        }
        if asset_in == asset_out {
            return Err(Error::SameAsset);
        }

        let mandate: Mandate = env
            .storage()
            .persistent()
            .get(&DataKey::Mandate(owner.clone()))
            .ok_or(Error::NoMandate)?;

        // The delegate proves itself. A different key holding the same request gets nowhere,
        // and the owner's key is not involved at all.
        mandate.delegate.require_auth();

        let sequence = env.ledger().sequence();
        if sequence > mandate.expiration_ledger {
            return Err(Error::Expired);
        }

        let base: Address = env.storage().instance().get(&DataKey::Base).unwrap();
        let router: Address = env.storage().instance().get(&DataKey::Router).unwrap();

        // Which leg is this, and what does the price bound demand of the swap?
        let bound_min_out = if asset_in == base {
            // Buying: base leaves the wallet, so both the cap and the ceiling price apply.
            if !mandate.assets.contains(&asset_out) {
                return Err(Error::AssetNotAllowed);
            }
            charge_window(&env, &owner, &mandate, amount_in, sequence)?;
            if mandate.buy_below > 0 {
                // price = amount_in / amount_out <= buy_below  ⟺  amount_out >= amount_in / buy_below
                div_ceil(mul(amount_in, PRICE_SCALE)?, mandate.buy_below)
            } else {
                0
            }
        } else if asset_out == base {
            // Selling: base comes back, so the cap does not apply — only the floor price.
            if !mandate.assets.contains(&asset_in) {
                return Err(Error::AssetNotAllowed);
            }
            if mandate.sell_above > 0 {
                // price = amount_out / amount_in >= sell_above  ⟺  amount_out >= amount_in * sell_above
                div_ceil(mul(amount_in, mandate.sell_above)?, PRICE_SCALE)
            } else {
                0
            }
        } else {
            // Every route in this system goes through the base asset; asset-to-asset legs
            // would escape both the cap and the price bounds.
            return Err(Error::NotBaseLeg);
        };

        // The bound becomes the swap's floor. If the market cannot meet it, the router
        // reverts and nothing moved — the price is checked on the executed trade, not on a
        // reading taken beforehand.
        let min_out = if bound_min_out > amount_out_min {
            bound_min_out
        } else {
            amount_out_min
        };

        let contract = env.current_contract_address();

        // Pull the input using the allowance the owner granted this contract.
        TokenClient::new(&env, &asset_in).transfer_from(&contract, &owner, &contract, &amount_in);

        let router_client = RouterClient::new(&env, &router);

        // The router moves the input out of this contract from a frame we do not own, and a
        // contract's own authorisation does not reach that far down the stack on its own. So
        // exactly one transfer is signed off here — this pair, this amount, nothing else.
        let pair = router_client.router_pair_for(&asset_in, &asset_out);
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: asset_in.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: (contract.clone(), pair, amount_in).into_val(&env),
                },
                sub_invocations: vec![&env],
            }),
        ]);

        let path = vec![&env, asset_in.clone(), asset_out.clone()];
        let deadline = env.ledger().timestamp() + SWAP_DEADLINE_SECS;
        let amounts = router_client.swap_exact_tokens_for_tokens(
            &amount_in, &min_out, &path, &contract, &deadline,
        );
        let amount_out = amounts.last().unwrap_or(0);

        // Forward the proceeds; the contract holds nothing between calls.
        TokenClient::new(&env, &asset_out).transfer(&contract, &owner, &amount_out);

        env.storage().persistent().extend_ttl(
            &DataKey::Mandate(owner.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );
        bump_instance(&env);

        MandateExecuted {
            owner,
            delegate: mandate.delegate,
            asset_in,
            asset_out,
            amount_in,
            amount_out,
        }
        .publish(&env);

        Ok(amount_out)
    }

    pub fn get_mandate(env: Env, owner: Address) -> Option<Mandate> {
        env.storage().persistent().get(&DataKey::Mandate(owner))
    }

    /// Base already spent inside the owner's current window. Returns 0 when there is no
    /// mandate, so the UI can call it unconditionally.
    pub fn spent(env: Env, owner: Address) -> i128 {
        let mandate: Option<Mandate> = env
            .storage()
            .persistent()
            .get(&DataKey::Mandate(owner.clone()));
        match mandate {
            Some(mandate) => {
                let window = env.ledger().sequence() / mandate.window_ledgers;
                env.storage()
                    .temporary()
                    .get(&DataKey::Spent(owner, window))
                    .unwrap_or(0)
            }
            None => 0,
        }
    }

    /// Point the contract at a different router deployment. Admin-only, and it cannot touch
    /// anyone's mandate or funds.
    pub fn set_router(env: Env, router: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Router, &router);
        bump_instance(&env);
    }

    pub fn router(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Router).unwrap()
    }

    pub fn base(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Base).unwrap()
    }
}

/// Charge this call against the owner's window allowance.
fn charge_window(
    env: &Env,
    owner: &Address,
    mandate: &Mandate,
    amount: i128,
    sequence: u32,
) -> Result<(), Error> {
    let window = sequence / mandate.window_ledgers;
    let key = DataKey::Spent(owner.clone(), window);

    let spent: i128 = env.storage().temporary().get(&key).unwrap_or(0);
    let total = spent.checked_add(amount).ok_or(Error::Overflow)?;
    if total > mandate.cap_per_window {
        return Err(Error::CapExceeded);
    }

    env.storage().temporary().set(&key, &total);
    // The counter never needs to outlive its own window.
    env.storage()
        .temporary()
        .extend_ttl(&key, mandate.window_ledgers, mandate.window_ledgers);
    Ok(())
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

fn mul(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_mul(b).ok_or(Error::Overflow)
}

fn div_ceil(numerator: i128, denominator: i128) -> i128 {
    (numerator + denominator - 1) / denominator
}

mod test;
